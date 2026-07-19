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

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fieldquote.core.config import get_settings
from fieldquote.domain.models import Invoice, Job, Payment, Proposal
from fieldquote.services.proposal_render import ProposalDocument

CENT = Decimal("0.01")


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
