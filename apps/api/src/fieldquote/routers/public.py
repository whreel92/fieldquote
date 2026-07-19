"""Public hosted-proposal endpoints — NO auth, keyed by the proposal's
public token. Powers the web /p/[token] page: view, sign, pay deposit,
decline. Only SENT proposals are visible; drafts 404 to the public.
"""

from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from fieldquote.core.config import get_settings
from fieldquote.core.db import get_db
from fieldquote.core.errors import ConflictError, NotFoundError
from fieldquote.domain.models import Company, Invoice
from fieldquote.integrations.stripe import StripeGateway, get_stripe, stripe_configured
from fieldquote.services import invoicing
from fieldquote.services import proposals as proposal_service

router = APIRouter(prefix="/p", tags=["public"])

Db = Annotated[Session, Depends(get_db)]
Stripe = Annotated[StripeGateway, Depends(get_stripe)]


class PublicProposal(BaseModel):
    status: str
    document: dict[str, Any]
    signed: bool
    signer_name: str | None
    expires_at: str | None
    payment: dict[str, Any]


class SignIn(BaseModel):
    signer_name: str = Field(min_length=1, max_length=200)
    signer_email: str | None = Field(default=None, max_length=320)
    consent: bool


class DeclineIn(BaseModel):
    reason: str | None = Field(default=None, max_length=1000)


def _payment_state(db: Session, proposal_id: Any, company: Company) -> dict[str, Any]:
    invoice = invoicing.deposit_invoice_for(db, proposal_id)
    return {
        "available": bool(company.stripe_account_id and company.stripe_charges_enabled),
        "stripe_live": stripe_configured(),
        "deposit_paid": bool(invoice and invoice.status == "paid"),
        "deposit_amount": str(invoice.total) if invoice else None,
        "invoice_token": invoice.public_token if invoice else None,
    }


def _public_view(db: Session, token: str, *, count_view: bool) -> PublicProposal:
    proposal = proposal_service.get_by_token(db, token)
    if proposal.snapshot is None:
        # Not sent yet — not public.
        raise NotFoundError("Proposal not found.")
    if count_view:
        proposal_service.record_view(db, proposal)
        db.commit()
        db.refresh(proposal)
    company = db.get(Company, proposal.company_id)
    if company is None:
        raise NotFoundError("Proposal not found.")
    from sqlalchemy import select

    from fieldquote.domain.models import Signature

    signature = db.scalar(select(Signature).where(Signature.proposal_id == proposal.id))
    return PublicProposal(
        status="expired" if proposal_service.is_expired(proposal) else proposal.status,
        document=proposal.snapshot,
        signed=signature is not None,
        signer_name=signature.signer_name if signature else None,
        expires_at=proposal.expires_at.isoformat() if proposal.expires_at else None,
        payment=_payment_state(db, proposal.id, company),
    )


@router.get("/{token}")
def view_proposal(token: str, db: Db) -> PublicProposal:
    return _public_view(db, token, count_view=True)


@router.post("/{token}/sign")
def sign(token: str, body: SignIn, request: Request, db: Db) -> PublicProposal:
    if not body.consent:
        raise ConflictError("You must accept the e-signature consent to sign.")
    proposal = proposal_service.get_by_token(db, token)
    if proposal.snapshot is None:
        raise NotFoundError("Proposal not found.")
    proposal_service.sign_proposal(
        db,
        proposal,
        signer_name=body.signer_name,
        signer_email=body.signer_email,
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    # Signature triggers the deposit invoice (§Phase 6.6).
    invoicing.create_deposit_invoice(db, proposal)
    db.commit()
    return _public_view(db, token, count_view=False)


@router.post("/{token}/checkout")
def create_deposit_checkout(token: str, db: Db, stripe: Stripe) -> dict[str, str]:
    proposal = proposal_service.get_by_token(db, token)
    if proposal.status != "signed":
        raise ConflictError("Sign the proposal before paying the deposit.")
    company = db.get(Company, proposal.company_id)
    if company is None or not company.stripe_account_id or not company.stripe_charges_enabled:
        raise ConflictError(
            "Online payment isn't set up for this contractor yet.",
            details={"code": "payments_unavailable"},
        )
    invoice = invoicing.deposit_invoice_for(db, proposal.id)
    if invoice is None:
        raise NotFoundError("Deposit invoice not found.")
    if invoice.status == "paid":
        raise ConflictError("This deposit has already been paid.")

    web = get_settings().public_web_url.rstrip("/")
    amount_cents = int((invoice.total * 100).to_integral_value())
    fee_cents = int(((invoice.application_fee or Decimal(0)) * 100).to_integral_value())
    session = stripe.create_deposit_checkout(
        account_id=company.stripe_account_id,
        amount_cents=amount_cents,
        application_fee_cents=fee_cents,
        currency="usd",
        success_url=f"{web}/p/{token}?paid=1",
        cancel_url=f"{web}/p/{token}",
        description=f"Deposit — {company.name}",
        metadata={"invoice_id": str(invoice.id), "proposal_id": str(proposal.id)},
    )
    invoice.stripe_checkout_session_id = session.session_id
    if session.payment_intent_id:
        invoice.stripe_payment_intent_id = session.payment_intent_id
    db.commit()
    return {"url": session.url}


@router.post("/{token}/decline")
def decline(token: str, body: DeclineIn, db: Db) -> PublicProposal:
    proposal = proposal_service.get_by_token(db, token)
    if proposal.snapshot is None:
        raise NotFoundError("Proposal not found.")
    proposal_service.decline_proposal(db, proposal, body.reason)
    db.commit()
    return _public_view(db, token, count_view=False)


def _invoice_by_token(db: Session, token: str) -> Invoice:
    from sqlalchemy import select

    invoice = db.scalar(select(Invoice).where(Invoice.public_token == token))
    if invoice is None:
        raise NotFoundError("Invoice not found.")
    return invoice
