"""Stripe webhook receiver.

Signature-verified and IDEMPOTENT: every event id is recorded once in
`webhook_events`; a replay short-circuits. Payment events are additionally
deduped at the payment-intent level because `checkout.session.completed` and
`payment_intent.succeeded` both fire for one charge. Handles:
  - account.updated            → sync Connect charges-enabled
  - checkout.session.completed → record payment (full or partial), roll invoice
  - payment_intent.succeeded   → same, keyed by payment intent (belt & braces)
  - payment_intent.payment_failed → record the failed payment
  - charge.refunded            → record refunds, roll invoice status back

Fee/net come from the connected account's balance transaction when Stripe is
live (the true processing economics); the platform-fee estimate is the
fallback. A successful payment queues a receipt email.

Handler failures are logged and re-raised as 500 so Stripe retries — a webhook
failure is never silently swallowed (Appendix B)."""

import logging
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.domain.models import Company, Invoice, Payment, WebhookEvent
from fieldquote.integrations.stripe import (
    StripeError,
    StripeGateway,
    WebhookVerificationError,
    get_stripe,
)
from fieldquote.services import instrumentation, invoicing
from fieldquote.services.queue import Queue, get_queue

logger = logging.getLogger(__name__)

router = APIRouter(tags=["webhooks"])

Db = Annotated[Session, Depends(get_db)]
Stripe = Annotated[StripeGateway, Depends(get_stripe)]
Q = Annotated[Queue, Depends(get_queue)]


def _cents(value: Any) -> Decimal:
    return Decimal(int(value)) / 100


def _find_invoice(db: Session, obj: dict[str, Any], intent_id: str | None) -> Invoice | None:
    invoice = invoicing.get_invoice_by_payment_intent(db, intent_id) if intent_id else None
    if invoice is None:
        session_id = obj.get("id")
        if session_id:
            invoice = invoicing.get_invoice_by_checkout_session(db, str(session_id))
    if invoice is None:
        meta = obj.get("metadata") or {}
        invoice_id = meta.get("invoice_id")
        if invoice_id:
            invoice = db.get(Invoice, invoice_id)
    return invoice


def _handle_account_updated(
    db: Session, stripe: StripeGateway, obj: dict[str, Any]
) -> Payment | None:
    account_id = obj.get("id")
    if not account_id:
        return None
    from sqlalchemy import select

    company = db.scalar(select(Company).where(Company.stripe_account_id == account_id))
    if company is not None:
        company.stripe_charges_enabled = bool(obj.get("charges_enabled"))
    return None


def _economics(
    stripe: StripeGateway,
    db: Session,
    invoice: Invoice,
    amount: Decimal,
    intent_id: str | None,
) -> tuple[Decimal, Decimal]:
    """(fee, net) for a settled charge — real balance-transaction numbers when
    reachable, platform-fee estimate otherwise."""
    company = db.get(Company, invoice.company_id)
    if intent_id and company and company.stripe_account_id:
        try:
            breakdown = stripe.get_payment_breakdown(
                account_id=company.stripe_account_id, payment_intent_id=intent_id
            )
        except StripeError:
            logger.warning("balance_txn_lookup_failed", extra={"intent": intent_id})
            breakdown = None
        if breakdown is not None:
            return _cents(breakdown.fee_cents), _cents(breakdown.net_cents)
    fee = invoicing.application_fee(amount)
    return fee, amount - fee


def _apply_payment(
    db: Session,
    stripe: StripeGateway,
    invoice: Invoice,
    obj: dict[str, Any],
    intent_id: str | None,
) -> Payment | None:
    if intent_id and invoicing.payment_exists_for_intent(db, invoice.id, intent_id):
        return None
    if invoice.status == "paid":
        return None
    amount = _cents(obj.get("amount_total") or obj.get("amount") or 0)
    if amount <= 0:
        return None
    fee, net = _economics(stripe, db, invoice, amount, intent_id)
    payment = invoicing.apply_successful_payment(
        db,
        invoice,
        amount=amount,
        fee=fee,
        net=net,
        raw=obj,
        payment_intent_id=intent_id,
    )
    instrumentation.record_payment_collected(
        invoice_id=str(invoice.id),
        kind=invoice.kind,
        amount=str(amount),
        fee=str(fee),
        net=str(net),
        platform_fee=str(invoicing.application_fee(amount)),
    )
    return payment


def _handle_checkout_completed(
    db: Session, stripe: StripeGateway, obj: dict[str, Any]
) -> Payment | None:
    intent_id = obj.get("payment_intent")
    invoice = _find_invoice(db, obj, intent_id)
    if invoice is None:
        logger.warning("checkout_completed_no_invoice", extra={"session": obj.get("id")})
        return None
    return _apply_payment(db, stripe, invoice, obj, intent_id)


def _handle_payment_intent_succeeded(
    db: Session, stripe: StripeGateway, obj: dict[str, Any]
) -> Payment | None:
    intent_id = obj.get("id")
    invoice = _find_invoice(db, obj, intent_id)
    if invoice is None:
        return None
    return _apply_payment(db, stripe, invoice, obj, intent_id)


def _handle_payment_failed(
    db: Session, stripe: StripeGateway, obj: dict[str, Any]
) -> Payment | None:
    intent_id = obj.get("id")
    invoice = (
        invoicing.get_invoice_by_payment_intent(db, intent_id) if intent_id else None
    )
    if invoice is None:
        return None
    invoicing.record_payment(
        db,
        invoice,
        amount=_cents(obj.get("amount") or 0),
        fee=None,
        net=None,
        status="failed",
        raw=obj,
    )
    return None


def _handle_charge_refunded(
    db: Session, stripe: StripeGateway, obj: dict[str, Any]
) -> Payment | None:
    intent_id = obj.get("payment_intent")
    invoice = _find_invoice(db, obj, intent_id)
    if invoice is None:
        logger.warning("charge_refunded_no_invoice", extra={"charge": obj.get("id")})
        return None
    refunds = list(((obj.get("refunds") or {}).get("data")) or [])
    if refunds:
        for refund in refunds:
            refund_id = str(refund.get("id"))
            if invoicing.refund_recorded(db, invoice.id, refund_id):
                continue
            amount = _cents(refund.get("amount") or 0)
            if amount > 0:
                invoicing.record_refund(
                    db, invoice, amount=amount, refund_id=refund_id, raw=dict(refund)
                )
        return None
    # No refund list on the event — reconcile against the running total.
    total_refunded = _cents(obj.get("amount_refunded") or 0)
    delta = total_refunded - invoicing.refunded_total(db, invoice.id)
    if delta > 0:
        invoicing.record_refund(
            db, invoice, amount=delta, refund_id=f"charge:{obj.get('id')}", raw=obj
        )
    return None


HANDLERS = {
    "account.updated": _handle_account_updated,
    "checkout.session.completed": _handle_checkout_completed,
    "payment_intent.succeeded": _handle_payment_intent_succeeded,
    "payment_intent.payment_failed": _handle_payment_failed,
    "charge.refunded": _handle_charge_refunded,
}


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request, db: Db, stripe: Stripe, queue: Q) -> Response:
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

    payment: Payment | None = None
    handler = HANDLERS.get(event_type)
    if handler is not None:
        obj = event.get("data", {}).get("object", {})
        try:
            payment = handler(db, stripe, obj)
        except Exception:
            logger.exception("webhook_handler_failed", extra={"event": event_type})
            db.rollback()
            # Re-raise so Stripe retries; the event id was rolled back too.
            raise
    from datetime import UTC, datetime

    processed = db.get(WebhookEvent, event_id) if event_id else None
    if processed is not None:
        processed.processed_at = datetime.now(tz=UTC)
    payment_id = str(payment.id) if payment is not None else None
    db.commit()
    if payment_id is not None:
        # Receipt email is best-effort and must never fail the webhook ack.
        try:
            await queue.enqueue_send_receipt(payment_id)
        except Exception:
            logger.exception("receipt_enqueue_failed", extra={"payment": payment_id})
    return Response(status_code=200, content='{"status":"ok"}')
