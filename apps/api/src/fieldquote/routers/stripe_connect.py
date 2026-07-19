"""Stripe Connect Express onboarding (contractor Settings → Get Paid).

Creates/links an Express account and reports charge-enabled status. The
webhook (`account.updated`) is the authoritative status source; this endpoint
also polls on demand so the mobile UI can refresh after the onboarding
redirect.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from fieldquote.core.config import get_settings
from fieldquote.core.db import get_db
from fieldquote.core.errors import AppError
from fieldquote.core.tenancy import TenantContext, get_current_context, require_role
from fieldquote.integrations.stripe import StripeError, StripeGateway, get_stripe

router = APIRouter(prefix="/stripe/connect", tags=["stripe"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]
Stripe = Annotated[StripeGateway, Depends(get_stripe)]


class ConnectStatus(BaseModel):
    connected: bool
    charges_enabled: bool
    details_submitted: bool
    payouts_enabled: bool
    account_id: str | None


class AccountLink(BaseModel):
    url: str


@router.get("/status")
def status(ctx: Ctx, db: Db, stripe: Stripe) -> ConnectStatus:
    company = ctx.company
    if not company.stripe_account_id:
        return ConnectStatus(
            connected=False,
            charges_enabled=False,
            details_submitted=False,
            payouts_enabled=False,
            account_id=None,
        )
    try:
        account = stripe.get_account(company.stripe_account_id)
    except StripeError as exc:
        raise AppError(
            "Couldn't reach Stripe. Try again.", details={"code": "stripe_error"}
        ) from exc
    company.stripe_charges_enabled = account.charges_enabled
    db.commit()
    return ConnectStatus(
        connected=True,
        charges_enabled=account.charges_enabled,
        details_submitted=account.details_submitted,
        payouts_enabled=account.payouts_enabled,
        account_id=company.stripe_account_id,
    )


@router.post("/onboard")
def onboard(ctx: Ctx, db: Db, stripe: Stripe) -> AccountLink:
    require_role(ctx, "owner", "admin")
    company = ctx.company
    try:
        if not company.stripe_account_id:
            company.stripe_account_id = stripe.create_connect_account(
                company_id=str(company.id), email=company.email
            )
            db.commit()
        web = get_settings().public_web_url.rstrip("/")
        url = stripe.create_account_link(
            company.stripe_account_id,
            refresh_url=f"{web}/app/payments?refresh=1",
            return_url=f"{web}/app/payments?done=1",
        )
    except StripeError as exc:
        raise AppError(
            "Couldn't start Stripe onboarding. Try again.", details={"code": "stripe_error"}
        ) from exc
    return AccountLink(url=url)
