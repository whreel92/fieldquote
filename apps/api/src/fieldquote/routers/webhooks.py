"""Stripe webhook receiver.

Signature-verified and IDEMPOTENT: every event id is recorded once in
`webhook_events`; a replay short-circuits. Handles:
  - account.updated          → sync Connect charges-enabled
  - checkout.session.completed → record payment, mark deposit paid, advance job
  - payment_intent.succeeded → same, keyed by payment intent (belt & braces)
  - payment_intent.payment_failed → record the failed payment

Handler failures are logged and re-raised as 500 so Stripe retries — a webhook
failure is never silently swallowed (Appendix B)."""

import logging
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.domain.models import Company, Invoice, WebhookEvent
from fieldquote.integrations.stripe import (
    StripeGateway,
    WebhookVerificationError,
    get_stripe,
)
from fieldquote.services import invoicing

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])

Db = Annotated[Session, Depends(get_db)]
Stripe = Annotated[StripeGateway, Depends(get_stripe)]


def _cents(value: Any) -> Decimal:
    return Decimal(int(value)) / 100


def _handle_account_updated(db: Session, obj: dict[str, Any]) -> None:
    account_id = obj.get("id")
    if not account_id:
        return
    from sqlalchemy import select

    company = db.scalar(select(Company).where(Company.stripe_account_id == account_id))
    if company is not None:
        company.stripe_charges_enabled = bool(obj.get("charges_enabled"))


def _apply_deposit_paid(
    db: Session, invoice: Invoice, obj: dict[str, Any], payment_intent_id: str | None
) -> None:
    if invoice.status == "paid":
        return
    amount = _cents(obj.get("amount_total") or obj.get("amount") or 0)
    fee = invoice.application_fee
    net = amount - (fee or Decimal(0))
    invoicing.record_payment(
        db,
        invoice,
        amount=amount,
        fee=fee,
        net=net,
        status="succeeded",
        raw=obj,
    )
    invoicing.mark_invoice_paid(db, invoice, payment_intent_id)


def _handle_checkout_completed(db: Session, obj: dict[str, Any]) -> None:
    session_id = obj.get("id")
    invoice = (
        invoicing.get_invoice_by_checkout_session(db, session_id) if session_id else None
    )
    if invoice is None:
        meta = obj.get("metadata") or {}
        invoice_id = meta.get("invoice_id")
        if invoice_id:
            invoice = db.get(Invoice, invoice_id)
    if invoice is None:
        logger.warning("checkout_completed_no_invoice", extra={"session": session_id})
        return
    _apply_deposit_paid(db, invoice, obj, obj.get("payment_intent"))


def _handle_payment_intent_succeeded(db: Session, obj: dict[str, Any]) -> None:
    intent_id = obj.get("id")
    invoice = (
        invoicing.get_invoice_by_payment_intent(db, intent_id) if intent_id else None
    )
    if invoice is None:
        meta = obj.get("metadata") or {}
        invoice_id = meta.get("invoice_id")
        if invoice_id:
            invoice = db.get(Invoice, invoice_id)
    if invoice is None:
        return
    _apply_deposit_paid(db, invoice, obj, intent_id)


def _handle_payment_failed(db: Session, obj: dict[str, Any]) -> None:
    intent_id = obj.get("id")
    invoice = (
        invoicing.get_invoice_by_payment_intent(db, intent_id) if intent_id else None
    )
    if invoice is None:
        return
    invoicing.record_payment(
        db,
        invoice,
        amount=_cents(obj.get("amount") or 0),
        fee=None,
        net=None,
        status="failed",
        raw=obj,
    )


HANDLERS = {
    "account.updated": _handle_account_updated,
    "checkout.session.completed": _handle_checkout_completed,
    "payment_intent.succeeded": _handle_payment_intent_succeeded,
    "payment_intent.payment_failed": _handle_payment_failed,
}


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request, db: Db, stripe: Stripe) -> Response:
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.verify_webhook(payload, sig)
    except WebhookVerificationError:
        return Response(status_code=400, content='{"error":"invalid signature"}')

    event_id = str(event.get("id", ""))
    event_type = str(event.get("type", ""))

    # Idempotency: skip if we've already processed this event id.
    if event_id and db.get(WebhookEvent, event_id) is not None:
        return Response(status_code=200, content='{"status":"duplicate"}')
    if event_id:
        db.add(WebhookEvent(id=event_id, provider="stripe", type=event_type))
        db.flush()

    handler = HANDLERS.get(event_type)
    if handler is not None:
        obj = event.get("data", {}).get("object", {})
        try:
            handler(db, obj)
        except Exception:
            logger.exception("webhook_handler_failed", extra={"event": event_type})
            db.rollback()
            # Re-raise so Stripe retries; the event id was rolled back too.
            raise
    from datetime import UTC, datetime

    processed = db.get(WebhookEvent, event_id) if event_id else None
    if processed is not None:
        processed.processed_at = datetime.now(tz=UTC)
    db.commit()
    return Response(status_code=200, content='{"status":"ok"}')
