"""Public hosted-invoice endpoints — NO auth, keyed by the invoice's public
token. Powers the web /i/[token] pay page: view + checkout (card or ACH,
full or partial amount). Draft invoices have no token and 404 to the public.
"""

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.config import get_settings
from fieldquote.core.db import get_db
from fieldquote.core.errors import ConflictError, NotFoundError
from fieldquote.domain.models import Company, Invoice, Job
from fieldquote.integrations.stripe import StripeGateway, get_stripe, stripe_configured
from fieldquote.services import invoicing

router = APIRouter(prefix="/i", tags=["public-invoices"])

Db = Annotated[Session, Depends(get_db)]
Stripe = Annotated[StripeGateway, Depends(get_stripe)]

PAYMENT_METHODS = ("card", "us_bank_account")


class PublicPaymentRow(BaseModel):
    amount: str
    status: str
    created_at: str


class PublicInvoice(BaseModel):
    status: str
    number: str
    kind: str
    company: dict[str, Any]
    job_title: str | None
    line_items: list[dict[str, Any]]
    subtotal: str
    tax: str
    total: str
    amount_paid: str
    balance_due: str
    due_at: str | None
    paid_at: str | None
    payments: list[PublicPaymentRow]
    payment: dict[str, Any]


class CheckoutIn(BaseModel):
    amount: str | None = Field(default=None, max_length=20)
    method: str = "card"


def _invoice_by_token(db: Session, token: str) -> Invoice:
    invoice = db.scalar(select(Invoice).where(Invoice.public_token == token))
    if invoice is None or invoice.status == "draft":
        raise NotFoundError("Invoice not found.")
    return invoice


def _public_view(db: Session, invoice: Invoice) -> PublicInvoice:
    company = db.get(Company, invoice.company_id)
    if company is None:
        raise NotFoundError("Invoice not found.")
    job = db.get(Job, invoice.job_id)
    balance = invoicing.invoice_balance(db, invoice)
    paid = invoicing.refundable_amount(db, invoice)
    settled_rows = [
        PublicPaymentRow(
            amount=str(p.amount),
            status=p.status,
            created_at=p.created_at.isoformat(),
        )
        for p in invoicing.payments_for_invoice(db, invoice.id)
        if p.status in invoicing.PAID_STATUSES
    ]
    overdue = bool(
        invoice.due_at
        and invoice.status in invoicing.PAYABLE_STATUSES
        and invoice.due_at < datetime.now(tz=UTC)
    )
    return PublicInvoice(
        status="overdue" if overdue else invoice.status,
        number=invoice.number,
        kind=invoice.kind,
        company={
            "name": company.name,
            "logo_url": company.logo_url,
            "license_number": company.license_number,
            "phone": company.phone,
            "email": company.email,
            "address": company.address,
        },
        job_title=job.title if job else None,
        line_items=invoice.line_items or [],
        subtotal=str(invoice.subtotal),
        tax=str(invoice.tax),
        total=str(invoice.total),
        amount_paid=str(paid),
        balance_due=str(balance),
        due_at=invoice.due_at.isoformat() if invoice.due_at else None,
        paid_at=invoice.paid_at.isoformat() if invoice.paid_at else None,
        payments=settled_rows,
        payment={
            "available": bool(company.stripe_account_id and company.stripe_charges_enabled),
            "stripe_live": stripe_configured(),
            "methods": list(PAYMENT_METHODS),
        },
    )


@router.get("/{token}")
def view_invoice(token: str, db: Db) -> PublicInvoice:
    return _public_view(db, _invoice_by_token(db, token))


@router.post("/{token}/checkout")
def create_invoice_checkout(
    token: str, body: CheckoutIn, db: Db, stripe: Stripe
) -> dict[str, str]:
    invoice = _invoice_by_token(db, token)
    if invoice.status == "paid":
        raise ConflictError("This invoice has already been paid.")
    if invoice.status not in invoicing.PAYABLE_STATUSES:
        raise ConflictError("This invoice can't be paid online.")
    if body.method not in PAYMENT_METHODS:
        raise ConflictError("Unsupported payment method.")
    company = db.get(Company, invoice.company_id)
    if company is None or not company.stripe_account_id or not company.stripe_charges_enabled:
        raise ConflictError(
            "Online payment isn't set up for this contractor yet.",
            details={"code": "payments_unavailable"},
        )
    balance = invoicing.invoice_balance(db, invoice)
    if body.amount is not None:
        try:
            amount = Decimal(body.amount)
        except InvalidOperation as exc:
            raise ConflictError("Enter a valid payment amount.") from exc
    else:
        amount = balance
    amount = amount.quantize(Decimal("0.01"))
    if amount < invoicing.MIN_CHARGE:
        raise ConflictError("The minimum online payment is $0.50.")
    if amount > balance:
        raise ConflictError("Payment amount exceeds the balance due.")

    web = get_settings().public_web_url.rstrip("/")
    amount_cents = int((amount * 100).to_integral_value())
    fee_cents = int((invoicing.application_fee(amount) * 100).to_integral_value())
    session = stripe.create_invoice_checkout(
        account_id=company.stripe_account_id,
        amount_cents=amount_cents,
        application_fee_cents=fee_cents,
        currency="usd",
        success_url=f"{web}/i/{token}?paid=1",
        cancel_url=f"{web}/i/{token}",
        description=f"Invoice {invoice.number} — {company.name}",
        metadata={"invoice_id": str(invoice.id)},
        payment_method_types=[body.method],
    )
    invoice.stripe_checkout_session_id = session.session_id
    if session.payment_intent_id:
        invoice.stripe_payment_intent_id = session.payment_intent_id
    db.commit()
    return {"url": session.url}
