"""Invoice + payment logic. Phase 6 scope: the deposit invoice a signed
proposal auto-creates, and applying a Stripe payment to it. Progress/final
invoices and the Money tab are Phase 7 — this module is written to extend.

Money math is Decimal; the platform application fee is computed from
`platform_fee_bps` and stored on the invoice so reconciliation (Phase 7) can
report the platform take separately."""

import secrets
import uuid
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fieldquote.core.config import get_settings
from fieldquote.domain.models import Invoice, Job, Payment, Proposal
from fieldquote.services.proposal_render import ProposalDocument

CENT = Decimal("0.01")
PAYABLE_STATUSES = {"sent", "partial", "overdue"}
# Rows that count toward the settled total. Refund rows carry NEGATIVE amounts
# so plain summation nets them out.
PAID_STATUSES = {"succeeded", "paid", "refunded"}
MIN_CHARGE = Decimal("0.50")


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _next_number(db: Session, company_id: uuid.UUID) -> str:
    count = db.scalar(
        select(func.count()).select_from(Invoice).where(Invoice.company_id == company_id)
    )
    return f"INV-{(count or 0) + 1:04d}"


def application_fee(amount: Decimal) -> Decimal:
    bps = get_settings().platform_fee_bps
    return _money(amount * Decimal(bps) / Decimal(10_000))


def _invoice_paid_total(db: Session, invoice_id: uuid.UUID) -> Decimal:
    amount = db.scalar(
        select(func.coalesce(func.sum(Payment.amount), 0)).where(
            Payment.invoice_id == invoice_id,
            Payment.status.in_(PAID_STATUSES),
        )
    )
    return _money(Decimal(str(amount or 0)))


def invoice_balance(db: Session, invoice: Invoice) -> Decimal:
    return max(_money(invoice.total - _invoice_paid_total(db, invoice.id)), Decimal(0))


def contract_total_for_job(db: Session, company_id: uuid.UUID, job_id: uuid.UUID) -> Decimal:
    """Return the latest frozen proposal total for this job."""
    from fieldquote.domain.models import Estimate

    snapshot = db.scalar(
        select(Proposal.snapshot)
        .join(Estimate, Proposal.estimate_id == Estimate.id)
        .where(
            Proposal.company_id == company_id,
            Estimate.job_id == job_id,
            Proposal.snapshot.is_not(None),
        )
        .order_by(Proposal.sent_at.desc().nullslast(), Proposal.version.desc())
        .limit(1)
    )
    if not snapshot:
        return Decimal(0)
    return _money(Decimal(str(snapshot.get("total", "0"))))


def invoiced_total(
    db: Session,
    company_id: uuid.UUID,
    job_id: uuid.UUID,
    *,
    exclude_invoice_id: uuid.UUID | None = None,
) -> Decimal:
    stmt = select(func.coalesce(func.sum(Invoice.total), 0)).where(
        Invoice.company_id == company_id,
        Invoice.job_id == job_id,
        Invoice.status != "void",
    )
    if exclude_invoice_id is not None:
        stmt = stmt.where(Invoice.id != exclude_invoice_id)
    return _money(Decimal(str(db.scalar(stmt) or 0)))


def remaining_balance(
    db: Session,
    company_id: uuid.UUID,
    job_id: uuid.UUID,
    *,
    exclude_invoice_id: uuid.UUID | None = None,
) -> Decimal:
    total = contract_total_for_job(db, company_id, job_id)
    invoiced = invoiced_total(db, company_id, job_id, exclude_invoice_id=exclude_invoice_id)
    return max(_money(total - invoiced), Decimal(0))


def create_progress_or_final_invoice(
    db: Session,
    *,
    company_id: uuid.UUID,
    job_id: uuid.UUID,
    kind: str,
    amount: Decimal | None,
    percent: Decimal | None,
    description: str | None,
    due_at: datetime | None,
) -> Invoice:
    if kind not in {"progress", "final"}:
        raise ValueError("invoice kind must be progress or final")
    contract_total = contract_total_for_job(db, company_id, job_id)
    if contract_total <= 0:
        raise ValueError("job has no sent proposal total")
    balance = remaining_balance(db, company_id, job_id)
    if kind == "final":
        invoice_total = balance
        label = description or "Final balance"
    elif amount is not None:
        invoice_total = _money(amount)
        label = description or "Progress payment"
    elif percent is not None:
        invoice_total = _money(contract_total * percent / Decimal(100))
        label = description or f"Progress payment ({percent}%)"
    else:
        raise ValueError("progress invoice requires amount or percent")
    if invoice_total <= 0:
        raise ValueError("invoice total must be greater than zero")
    if invoice_total > balance:
        raise ValueError("invoice total exceeds remaining balance")

    invoice = Invoice(
        company_id=company_id,
        job_id=job_id,
        kind=kind,
        number=_next_number(db, company_id),
        status="draft",
        line_items=[{"description": label, "amount": str(invoice_total)}],
        subtotal=invoice_total,
        tax=Decimal(0),
        total=invoice_total,
        due_at=due_at,
        application_fee=application_fee(invoice_total),
    )
    db.add(invoice)
    db.flush()
    return invoice


def update_draft_invoice(
    db: Session,
    invoice: Invoice,
    *,
    amount: Decimal | None,
    description: str | None,
    due_at: datetime | None,
) -> None:
    if invoice.status != "draft":
        raise ValueError("sent invoices are immutable")
    if amount is not None:
        amount = _money(amount)
        if amount <= 0:
            raise ValueError("invoice total must be greater than zero")
        balance = remaining_balance(
            db,
            invoice.company_id,
            invoice.job_id,
            exclude_invoice_id=invoice.id,
        )
        if amount > balance:
            raise ValueError("invoice total exceeds remaining balance")
        invoice.subtotal = amount
        invoice.total = amount
        invoice.application_fee = application_fee(amount)
    if description is not None or amount is not None:
        current = invoice.line_items[0] if invoice.line_items else {}
        label = description or str(current.get("description") or "Invoice")
        invoice.line_items = [{"description": label, "amount": str(invoice.total)}]
    if due_at is not None:
        invoice.due_at = due_at


def send_invoice(invoice: Invoice) -> None:
    if invoice.status != "draft":
        raise ValueError("invoice has already been sent")
    invoice.status = "sent"
    invoice.public_token = invoice.public_token or secrets.token_urlsafe(24)
    invoice.sent_at = datetime.now(tz=UTC)


def invoice_summary(db: Session, company_id: uuid.UUID) -> dict[str, Any]:
    invoices = db.scalars(
        select(Invoice).where(Invoice.company_id == company_id).order_by(Invoice.created_at.desc())
    ).all()
    now = datetime.now(tz=UTC)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    outstanding = Decimal(0)
    paid_this_month = Decimal(0)
    in_transit = Decimal(0)
    for invoice in invoices:
        balance = invoice_balance(db, invoice)
        if invoice.status in PAYABLE_STATUSES:
            outstanding += balance
        payments = db.scalars(
            select(Payment).where(
                Payment.invoice_id == invoice.id,
                Payment.status.in_(PAID_STATUSES),
            )
        )
        for payment in payments:
            if payment.created_at >= month_start:
                paid_this_month += payment.amount
                if payment.net is not None:
                    in_transit += payment.net
    return {
        "outstanding": str(_money(outstanding)),
        "paid_this_month": str(_money(paid_this_month)),
        "in_transit": str(_money(in_transit)),
    }


def deposit_invoice_for(db: Session, proposal_id: uuid.UUID) -> Invoice | None:
    return db.scalar(
        select(Invoice).where(
            Invoice.proposal_id == proposal_id, Invoice.kind == "deposit"
        )
    )


def create_deposit_invoice(db: Session, proposal: Proposal) -> Invoice:
    """Idempotent: one deposit invoice per proposal. Amount comes from the
    frozen snapshot (never recomputed)."""
    existing = deposit_invoice_for(db, proposal.id)
    if existing is not None:
        return existing
    document = ProposalDocument.model_validate(proposal.snapshot)
    amount = _money(Decimal(document.deposit_amount))
    from fieldquote.domain.models import Estimate

    estimate = db.get(Estimate, proposal.estimate_id)
    job_id = estimate.job_id if estimate is not None else None
    if job_id is None:
        raise ValueError("proposal has no job")
    invoice = Invoice(
        company_id=proposal.company_id,
        job_id=job_id,
        proposal_id=proposal.id,
        kind="deposit",
        number=_next_number(db, proposal.company_id),
        status="sent",
        line_items=[{"description": document.deposit_label, "amount": document.deposit_amount}],
        subtotal=amount,
        tax=Decimal(0),
        total=amount,
        application_fee=application_fee(amount),
        public_token=secrets.token_urlsafe(24),
        sent_at=datetime.now(tz=UTC),
    )
    db.add(invoice)
    db.flush()
    return invoice


def get_invoice_by_checkout_session(db: Session, session_id: str) -> Invoice | None:
    return db.scalar(
        select(Invoice).where(Invoice.stripe_checkout_session_id == session_id)
    )


def get_invoice_by_payment_intent(db: Session, payment_intent_id: str) -> Invoice | None:
    return db.scalar(
        select(Invoice).where(Invoice.stripe_payment_intent_id == payment_intent_id)
    )


def record_payment(
    db: Session,
    invoice: Invoice,
    *,
    amount: Decimal,
    fee: Decimal | None,
    net: Decimal | None,
    status: str,
    raw: dict[str, object],
) -> Payment:
    payment = Payment(
        company_id=invoice.company_id,
        invoice_id=invoice.id,
        provider="stripe",
        amount=_money(amount),
        fee=_money(fee) if fee is not None else None,
        net=_money(net) if net is not None else None,
        status=status,
        raw=raw,
    )
    db.add(payment)
    return payment


def mark_invoice_paid(db: Session, invoice: Invoice, payment_intent_id: str | None) -> None:
    invoice.status = "paid"
    invoice.paid_at = datetime.now(tz=UTC)
    if payment_intent_id:
        invoice.stripe_payment_intent_id = payment_intent_id
    # Deposit paid → advance the job to won (§Phase 6.6).
    job = db.get(Job, invoice.job_id)
    if job is not None and job.status in {"sent", "estimating", "lead"}:
        job.status = "won"


def payments_for_invoice(db: Session, invoice_id: uuid.UUID) -> list[Payment]:
    return list(
        db.scalars(
            select(Payment)
            .where(Payment.invoice_id == invoice_id)
            .order_by(Payment.created_at.asc())
        )
    )


def payment_exists_for_intent(db: Session, invoice_id: uuid.UUID, intent_id: str) -> bool:
    """Intent-level dedup: `checkout.session.completed` and
    `payment_intent.succeeded` both fire for one charge — record it once."""
    for payment in payments_for_invoice(db, invoice_id):
        raw = payment.raw or {}
        if payment.status == "succeeded" and (
            raw.get("payment_intent") == intent_id or raw.get("id") == intent_id
        ):
            return True
    return False


def apply_successful_payment(
    db: Session,
    invoice: Invoice,
    *,
    amount: Decimal,
    fee: Decimal | None,
    net: Decimal | None,
    raw: dict[str, object],
    payment_intent_id: str | None,
) -> Payment:
    """Record a settled charge and roll the invoice status forward:
    balance cleared → paid (advances the job for deposits); otherwise partial."""
    payment = record_payment(
        db, invoice, amount=amount, fee=fee, net=net, status="succeeded", raw=raw
    )
    db.flush()
    if invoice_balance(db, invoice) <= 0:
        mark_invoice_paid(db, invoice, payment_intent_id)
    else:
        invoice.status = "partial"
        if payment_intent_id:
            invoice.stripe_payment_intent_id = payment_intent_id
    return payment


def refunded_total(db: Session, invoice_id: uuid.UUID) -> Decimal:
    """Total refunded so far, as a positive number."""
    total = Decimal(0)
    for payment in payments_for_invoice(db, invoice_id):
        if payment.status == "refunded":
            total += -payment.amount
    return _money(total)


def refund_recorded(db: Session, invoice_id: uuid.UUID, refund_id: str) -> bool:
    for payment in payments_for_invoice(db, invoice_id):
        if payment.status == "refunded" and (payment.raw or {}).get("refund_id") == refund_id:
            return True
    return False


def record_refund(
    db: Session,
    invoice: Invoice,
    *,
    amount: Decimal,
    refund_id: str,
    raw: dict[str, object],
) -> Payment:
    """Record a refund as a negative settled row and roll the invoice status:
    everything refunded → refunded (terminal); some money kept → partial/paid."""
    amount = _money(amount)
    if amount <= 0:
        raise ValueError("refund amount must be greater than zero")
    payment = record_payment(
        db,
        invoice,
        amount=-amount,
        fee=None,
        net=-amount,
        status="refunded",
        raw={**raw, "refund_id": refund_id},
    )
    db.flush()
    settled = _invoice_paid_total(db, invoice.id)
    if settled <= 0:
        invoice.status = "refunded"
    elif settled >= invoice.total:
        invoice.status = "paid"
    else:
        invoice.status = "partial"
    return payment


def refundable_amount(db: Session, invoice: Invoice) -> Decimal:
    return _invoice_paid_total(db, invoice.id)


def overdue_invoices(db: Session, *, as_of: datetime | None = None) -> list[Invoice]:
    """Phase 8 automation hook: open invoices past their due date. The
    sequences engine (invoice_overdue_3d trigger) consumes this."""
    now = as_of or datetime.now(tz=UTC)
    return list(
        db.scalars(
            select(Invoice).where(
                Invoice.status.in_(PAYABLE_STATUSES),
                Invoice.due_at.is_not(None),
                Invoice.due_at < now,
            )
        )
    )
