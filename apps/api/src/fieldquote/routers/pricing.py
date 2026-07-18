"""Pricing preview endpoint.

Prices a set of assembly selections against the company's rates and the
catalog snapshot WITHOUT creating an estimate. Used by dev tooling now and
by the estimate editor (Phase 5) for live re-pricing. All dollar amounts come
from the deterministic engine — this endpoint never invents numbers.
"""

from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.errors import AppError
from fieldquote.core.tenancy import TenantContext, get_current_context
from fieldquote.pricing import (
    PricedEstimate,
    PricingError,
    PricingRequest,
    price,
)
from fieldquote.services.catalog import company_region, load_catalog, load_company_rates

router = APIRouter(prefix="/pricing", tags=["pricing"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]


class PreviewLine(BaseModel):
    code: str
    qty: Decimal = Field(default=Decimal(1), gt=0)
    modifiers: list[str] = Field(default_factory=list)
    selected_tier: Literal["good", "better", "best"] | None = None


class PreviewAllowance(BaseModel):
    description: str
    amount: Decimal = Field(ge=0)
    reason: str = ""


class PreviewAdjustments(BaseModel):
    discount: Decimal = Field(default=Decimal(0), ge=0)
    margin_override_pct: Decimal | None = Field(default=None, ge=0)


class PreviewIn(BaseModel):
    assemblies: list[PreviewLine] = Field(default_factory=list)
    allowances: list[PreviewAllowance] = Field(default_factory=list)
    adjustments: PreviewAdjustments = PreviewAdjustments()


class PricingRequestError(AppError):
    status_code = 422
    code = "pricing_error"


@router.post("/preview")
def preview(body: PreviewIn, ctx: Ctx, db: Db) -> PricedEstimate:
    catalog = load_catalog(db, ctx.company)
    rates = load_company_rates(db, ctx.company)
    request = PricingRequest.model_validate(
        {
            "assemblies": [line.model_dump() for line in body.assemblies],
            "allowances": [allowance.model_dump() for allowance in body.allowances],
            "company_rates": rates,
            "region": company_region(ctx.company),
            "adjustments": body.adjustments.model_dump(),
        }
    )
    try:
        return price(request, catalog)
    except PricingError as exc:
        raise PricingRequestError(exc.message, details={"code": exc.code}) from exc
