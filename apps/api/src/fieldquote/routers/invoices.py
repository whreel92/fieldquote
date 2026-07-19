import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.errors import ConflictError, NotFoundError
from fieldquote.core.tenancy import TenantContext, get_current_context, require_role
from fieldquote.domain.models import Company, Invoice, Job
from fieldquote.integrations.stripe import StripeError, StripeGateway, get_stripe
from fieldquote.services import audit, invoicing
from fieldquote.services.queue import Queue, get_queue

router = APIRouter(tags=["invoices"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]
Stripe = Annotated[StripeGateway, Depends(get_stripe)]
Q = Annotated[Queue, Depends(get_queue)]

INVOICE_READY_STATUSES = {"won", "in_progress", "complete", "paid"}


class InvoiceOut(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    job_title: str | None
    kind: str
    number: str
    status: str
    line_items: list[dict[str, Any]]
    subtotal: Decimal
    tax: Decimal
    total: Decimal
    amount_paid: Decimal
    balance_due: Decimal
    due_at: datetime | None
    public_token: str | None
    sent_at: datetime | None
    paid_at: datetime | None
    created_at: datetime


class InvoiceCreate(BaseModel):
    kind: Literal["progress", "final"]
    amount: Decimal | None = Field(default=None, gt=0)
    percent: Decimal | None = Field(default=None, gt=0, le=100)
    description: str | None = Field(default=None, max_length=300)
    due_at: datetime | None = None


class InvoicePatch(BaseModel):
    amount: Decimal | None = Field(default=None, gt=0)
    description: str | None = Field(default=None, max_length=300)
    due_at: datetime | None = None


class MoneySummary(BaseModel):
    outstanding: Decimal
    paid_this_month: Decimal
    in_transit: Decimal
    invoices: list[InvoiceOut]


class PaymentOut(BaseModel):
    id: uuid.UUID
    amount: Decimal
    fee: Decimal | None
    net: Decimal | None
    status: str
    created_at: datetime


class InvoiceDetail(InvoiceOut):
    payments: list[PaymentOut]


class RefundIn(BaseModel):
    amount: Decimal | None = Field(default=None, gt=0)


def _owned_job(db: Session, ctx: TenantContext, job_id: uuid.UUID) -> Job:
    job = db.get(Job, job_id)
    if job is None or job.company_id != ctx.company.id:
        raise NotFoundError("Job not found.")
    return job


def _owned_invoice(db: Session, ctx: TenantContext, invoice_id: uuid.UUID) -> Invoice:
    invoice = db.get(Invoice, invoice_id)
    if invoice is None or invoice.company_id != ctx.company.id:
        raise NotFoundError("Invoice not found.")
    return invoice


def _out(db: Session, invoice: Invoice, job_title: str | None = None) -> InvoiceOut:
    paid = invoice.total - invoicing.invoice_balance(db, invoice)
    if job_title is None:
        job = db.get(Job, invoice.job_id)
        job_title = job.title if job else None
    return InvoiceOut(
        id=invoice.id,
        job_id=invoice.job_id,
        job_title=job_title,
        kind=invoice.kind,
        number=invoice.number,
        status=invoice.status,
        line_items=invoice.line_items or [],
        subtotal=invoice.subtotal,
        tax=invoice.tax,
        total=invoice.total,
        amount_paid=paid,
        balance_due=invoice.total - paid,
        due_at=invoice.due_at,
        public_token=invoice.public_token,
        sent_at=invoice.sent_at,
        paid_at=invoice.paid_at,
        created_at=invoice.created_at,
    )


def _create_invoice(body: InvoiceCreate, job: Job, ctx: TenantContext, db: Session) -> Invoice:
    if job.status not in INVOICE_READY_STATUSES:
        raise ConflictError(
            "Only won jobs can be invoiced.",
            details={"code": "job_not_won", "status": job.status},
        )
    try:
        invoice = invoicing.create_progress_or_final_invoice(
            db,
            company_id=ctx.company.id,
            job_id=job.id,
            kind=body.kind,
            amount=body.amount,
            percent=body.percent,
            description=body.description,
            due_at=body.due_at,
        )
    except ValueError as exc:
        raise ConflictError(str(exc)) from exc
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="invoice",
        entity_id=invoice.id,
        action="create",
        after={"job_id": str(job.id), "kind": invoice.kind, "total": str(invoice.total)},
    )
    return invoice


@router.get("/jobs/{job_id}/invoices")
def list_job_invoices(job_id: uuid.UUID, ctx: Ctx, db: Db) -> list[InvoiceOut]:
    _owned_job(db, ctx, job_id)
    rows = db.scalars(
        select(Invoice)
        .where(Invoice.company_id == ctx.company.id, Invoice.job_id == job_id)
        .order_by(Invoice.created_at.desc())
    )
    return [_out(db, row) for row in rows]


@router.post("/jobs/{job_id}/invoices", status_code=201)
def create_invoice(job_id: uuid.UUID, body: InvoiceCreate, ctx: Ctx, db: Db) -> InvoiceOut:
    require_role(ctx, "owner", "admin", "office")
    job = _owned_job(db, ctx, job_id)
    invoice = _create_invoice(body, job, ctx, db)
    db.commit()
    db.refresh(invoice)
    return _out(db, invoice, job.title)


@router.get("/invoices")
def list_invoices(ctx: Ctx, db: Db) -> list[InvoiceOut]:
    rows = db.execute(
        select(Invoice, Job.title)
        .join(Job, Invoice.job_id == Job.id)
        .where(Invoice.company_id == ctx.company.id)
        .order_by(Invoice.created_at.desc())
    )
    return [_out(db, invoice, title) for invoice, title in rows]


@router.patch("/invoices/{invoice_id}")
def update_invoice(
    invoice_id: uuid.UUID, body: InvoicePatch, ctx: Ctx, db: Db
) -> InvoiceOut:
    require_role(ctx, "owner", "admin", "office")
    invoice = _owned_invoice(db, ctx, invoice_id)
    before = {"total": str(invoice.total), "status": invoice.status}
    try:
        invoicing.update_draft_invoice(
            db,
            invoice,
            amount=body.amount,
            description=body.description,
            due_at=body.due_at,
        )
    except ValueError as exc:
        raise ConflictError(str(exc)) from exc
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="invoice",
        entity_id=invoice.id,
        action="update",
        before=before,
        after={"total": str(invoice.total), "status": invoice.status},
    )
    db.commit()
    db.refresh(invoice)
    return _out(db, invoice)


@router.post("/invoices/{invoice_id}/send")
async def send_invoice(invoice_id: uuid.UUID, ctx: Ctx, db: Db, queue: Q) -> InvoiceOut:
    require_role(ctx, "owner", "admin", "office")
    invoice = _owned_invoice(db, ctx, invoice_id)
    try:
        invoicing.send_invoice(invoice)
    except ValueError as exc:
        raise ConflictError(str(exc)) from exc
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="invoice",
        entity_id=invoice.id,
        action="send",
        after={"status": invoice.status, "public_token": invoice.public_token},
    )
    db.commit()
    db.refresh(invoice)
    # PDF render + client email happen in the worker.
    await queue.enqueue_deliver_invoice(str(invoice.id))
    return _out(db, invoice)


@router.get("/invoices/{invoice_id}")
def get_invoice(invoice_id: uuid.UUID, ctx: Ctx, db: Db) -> InvoiceDetail:
    invoice = _owned_invoice(db, ctx, invoice_id)
    base = _out(db, invoice)
    payments = [
        PaymentOut(
            id=p.id,
            amount=p.amount,
            fee=p.fee,
            net=p.net,
            status=p.status,
            created_at=p.created_at,
        )
        for p in invoicing.payments_for_invoice(db, invoice.id)
    ]
    return InvoiceDetail(**base.model_dump(), payments=payments)


@router.post("/invoices/{invoice_id}/remind")
async def remind_invoice(invoice_id: uuid.UUID, ctx: Ctx, db: Db, queue: Q) -> InvoiceOut:
    require_role(ctx, "owner", "admin", "office")
    invoice = _owned_invoice(db, ctx, invoice_id)
    if invoice.status not in invoicing.PAYABLE_STATUSES:
        raise ConflictError("Only sent, unpaid invoices can be nudged.")
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="invoice",
        entity_id=invoice.id,
        action="remind",
        after={"status": invoice.status},
    )
    db.commit()
    await queue.enqueue_remind_invoice(str(invoice.id))
    return _out(db, invoice)


@router.post("/invoices/{invoice_id}/refund")
def refund_invoice(
    invoice_id: uuid.UUID, body: RefundIn, ctx: Ctx, db: Db, stripe: Stripe
) -> InvoiceDetail:
    """Manual refund trigger (owner/admin). Refunds through Stripe on the
    connected account and records the refund immediately; the
    `charge.refunded` webhook is a no-op for refunds already recorded."""
    require_role(ctx, "owner", "admin")
    invoice = _owned_invoice(db, ctx, invoice_id)
    refundable = invoicing.refundable_amount(db, invoice)
    if refundable <= 0:
        raise ConflictError("There is nothing to refund on this invoice.")
    amount = body.amount if body.amount is not None else refundable
    if amount > refundable:
        raise ConflictError("Refund exceeds the amount collected.")
    if not invoice.stripe_payment_intent_id:
        raise ConflictError("This invoice was not paid online — refund it out of band.")
    company = db.get(Company, invoice.company_id)
    if company is None or not company.stripe_account_id:
        raise ConflictError("Stripe account is not connected.")
    try:
        refund_id = stripe.create_refund(
            account_id=company.stripe_account_id,
            payment_intent_id=invoice.stripe_payment_intent_id,
            amount_cents=int((amount * 100).to_integral_value()),
        )
    except StripeError as exc:
        raise ConflictError(
            "Stripe refused the refund. Try again or refund from the Stripe dashboard."
        ) from exc
    invoicing.record_refund(
        db,
        invoice,
        amount=amount,
        refund_id=refund_id,
        raw={"payment_intent": invoice.stripe_payment_intent_id, "source": "manual"},
    )
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="invoice",
        entity_id=invoice.id,
        action="refund",
        after={"amount": str(amount), "refund_id": refund_id, "status": invoice.status},
    )
    db.commit()
    db.refresh(invoice)
    return get_invoice(invoice_id, ctx, db)


@router.get("/money/summary")
def money_summary(ctx: Ctx, db: Db) -> MoneySummary:
    summary = invoicing.invoice_summary(db, ctx.company.id)
    return MoneySummary(
        outstanding=Decimal(str(summary["outstanding"])),
        paid_this_month=Decimal(str(summary["paid_this_month"])),
        in_transit=Decimal(str(summary["in_transit"])),
        invoices=list_invoices(ctx, db),
    )
