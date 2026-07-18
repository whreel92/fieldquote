import uuid
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.tenancy import TenantContext, get_current_context
from fieldquote.domain.models import CompanyRate
from fieldquote.integrations.storage import SignedUpload, StorageService, get_storage
from fieldquote.services import audit

router = APIRouter(tags=["company"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]


class CompanyOut(BaseModel):
    id: uuid.UUID
    name: str
    trade: str
    logo_url: str | None
    license_number: str | None
    insurance_line: str | None
    phone: str | None
    email: str | None
    address: str | None
    timezone: str
    settings: dict[str, Any]


class CompanyPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    logo_url: str | None = None
    license_number: str | None = None
    insurance_line: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    timezone: str | None = None
    settings: dict[str, Any] | None = None


_PATCHABLE = (
    "name", "logo_url", "license_number", "insurance_line",
    "phone", "email", "address", "timezone", "settings",
)  # fmt: skip


def _company_out(ctx: TenantContext) -> CompanyOut:
    c = ctx.company
    return CompanyOut(
        id=c.id,
        name=c.name,
        trade=c.trade,
        logo_url=c.logo_url,
        license_number=c.license_number,
        insurance_line=c.insurance_line,
        phone=c.phone,
        email=c.email,
        address=c.address,
        timezone=c.timezone,
        settings=c.settings,
    )


@router.get("/company")
def get_company(ctx: Ctx) -> CompanyOut:
    return _company_out(ctx)


@router.patch("/company")
def update_company(patch: CompanyPatch, ctx: Ctx, db: Db) -> CompanyOut:
    changes = patch.model_dump(exclude_unset=True)
    before = {k: getattr(ctx.company, k) for k in changes if k in _PATCHABLE}
    company = db.merge(ctx.company)
    for key, value in changes.items():
        if key in _PATCHABLE:
            setattr(company, key, value)
    audit.record(
        db,
        company_id=company.id,
        actor_id=ctx.user.id,
        entity="company",
        entity_id=company.id,
        action="update",
        before=before,
        after={k: v for k, v in changes.items() if k in _PATCHABLE},
    )
    db.commit()
    db.refresh(company)
    return _company_out(TenantContext(user=ctx.user, company=company))


class RatesOut(BaseModel):
    labor_rate: Decimal
    helper_rate: Decimal | None
    target_margin_pct: Decimal
    tax_rate_pct: Decimal
    markup_model: str
    confirmed: bool


class RatesPut(BaseModel):
    labor_rate: Decimal = Field(ge=0, le=10_000)
    helper_rate: Decimal | None = Field(default=None, ge=0, le=10_000)
    target_margin_pct: Decimal = Field(ge=0, lt=100)
    tax_rate_pct: Decimal = Field(ge=0, le=50)
    markup_model: str = Field(pattern="^(margin|markup)$")
    confirmed: bool = True


DEFAULT_RATES = {
    "labor_rate": Decimal(125),
    "helper_rate": Decimal(65),
    "target_margin_pct": Decimal(45),
    "tax_rate_pct": Decimal(0),
    "markup_model": "margin",
}


def _get_or_default(db: Session, company_id: uuid.UUID) -> tuple[CompanyRate, bool]:
    """Returns (rates_row, persisted). Unpersisted rows carry safe defaults
    (flagged `confirmed: false` so Settings can nag until the wizard confirms)."""
    row = db.get(CompanyRate, company_id)
    if row is not None:
        return row, True
    return CompanyRate(company_id=company_id, **DEFAULT_RATES), False


@router.get("/company/rates")
def get_rates(ctx: Ctx, db: Db) -> RatesOut:
    row, persisted = _get_or_default(db, ctx.company.id)
    confirmed = persisted and bool(ctx.company.settings.get("rates_confirmed"))
    return RatesOut(
        labor_rate=row.labor_rate,
        helper_rate=row.helper_rate,
        target_margin_pct=row.target_margin_pct,
        tax_rate_pct=row.tax_rate_pct,
        markup_model=row.markup_model,
        confirmed=confirmed,
    )


@router.put("/company/rates")
def put_rates(body: RatesPut, ctx: Ctx, db: Db) -> RatesOut:
    row, persisted = _get_or_default(db, ctx.company.id)
    before = (
        {
            "labor_rate": str(row.labor_rate),
            "helper_rate": str(row.helper_rate),
            "target_margin_pct": str(row.target_margin_pct),
            "tax_rate_pct": str(row.tax_rate_pct),
            "markup_model": row.markup_model,
        }
        if persisted
        else None
    )
    row.labor_rate = body.labor_rate
    row.helper_rate = body.helper_rate
    row.target_margin_pct = body.target_margin_pct
    row.tax_rate_pct = body.tax_rate_pct
    row.markup_model = body.markup_model
    db.add(row)
    company = db.merge(ctx.company)
    company.settings = {**company.settings, "rates_confirmed": body.confirmed}
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="company_rates",
        entity_id=ctx.company.id,
        action="update",
        before=before,
        after=body.model_dump(mode="json"),
    )
    db.commit()
    return RatesOut(
        labor_rate=row.labor_rate,
        helper_rate=row.helper_rate,
        target_margin_pct=row.target_margin_pct,
        tax_rate_pct=row.tax_rate_pct,
        markup_model=row.markup_model,
        confirmed=body.confirmed,
    )


class LogoUploadOut(BaseModel):
    upload_url: str
    token: str
    storage_path: str


@router.post("/company/logo-upload-url")
def logo_upload_url(
    ctx: Ctx,
    storage: Annotated[StorageService, Depends(get_storage)],
) -> LogoUploadOut:
    signed: SignedUpload = storage.create_signed_upload(
        "documents", f"{ctx.company.id}/branding/logo.png"
    )
    return LogoUploadOut(upload_url=signed.url, token=signed.token, storage_path=signed.path)
