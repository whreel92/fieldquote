"""Catalog browse/edit endpoints (internal admin + editor line search).

Reads are open to any authenticated user (the estimate editor searches
assemblies); writes are owner/admin only and bump the version. Every write
is audit-logged. Production companies without dev_mode only see
advisor-approved assemblies (same guard the pricing service applies).
"""

import uuid
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.errors import NotFoundError
from fieldquote.core.tenancy import TenantContext, get_current_context, require_role
from fieldquote.domain.models import Assembly, MaterialItem, Modifier
from fieldquote.services import audit
from fieldquote.services.catalog import approved_only

router = APIRouter(prefix="/catalog", tags=["catalog"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]


class AssemblyOut(BaseModel):
    code: str
    trade: str
    name: str
    description: str | None
    job_type_codes: list[str]
    unit: str
    labor_hours: Decimal
    helper_hours: Decimal
    labor_notes: str | None
    bom: list[dict[str, Any]]
    modifiers_allowed: list[str]
    option_tiers: list[dict[str, Any]] | None
    version: int
    status: str


class AssemblyPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    labor_hours: Decimal | None = Field(default=None, gt=0)
    helper_hours: Decimal | None = Field(default=None, ge=0)
    labor_notes: str | None = None
    modifiers_allowed: list[str] | None = None
    status: str | None = Field(default=None, pattern="^(draft|advisor_approved)$")


class ModifierOut(BaseModel):
    code: str
    name: str
    description: str | None
    effect: dict[str, Any]
    version: int


class MaterialOut(BaseModel):
    sku: str
    description: str
    unit: str
    category: str | None
    base_price: Decimal
    source: str | None


class AssemblyList(BaseModel):
    items: list[AssemblyOut]


class ModifierList(BaseModel):
    items: list[ModifierOut]


class MaterialList(BaseModel):
    items: list[MaterialOut]


def _assembly_out(row: Assembly) -> AssemblyOut:
    return AssemblyOut.model_validate(row, from_attributes=True)


@router.get("/assemblies")
def list_assemblies(
    ctx: Ctx,
    db: Db,
    job_type: Annotated[str | None, Query()] = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
) -> AssemblyList:
    stmt = select(Assembly)
    if approved_only(ctx.company):
        stmt = stmt.where(Assembly.status == "advisor_approved")
    if job_type:
        stmt = stmt.where(Assembly.job_type_codes.contains([job_type]))
    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(Assembly.name.ilike(pattern) | Assembly.code.ilike(pattern))
    stmt = stmt.order_by(Assembly.code)
    return AssemblyList(items=[_assembly_out(row) for row in db.scalars(stmt)])


@router.get("/assemblies/{code}")
def get_assembly(code: str, ctx: Ctx, db: Db) -> AssemblyOut:
    row = db.get(Assembly, code)
    if row is None or (approved_only(ctx.company) and row.status != "advisor_approved"):
        raise NotFoundError("Assembly not found.")
    return _assembly_out(row)


@router.patch("/assemblies/{code}")
def update_assembly(code: str, patch: AssemblyPatch, ctx: Ctx, db: Db) -> AssemblyOut:
    require_role(ctx, "owner", "admin")
    row = db.get(Assembly, code)
    if row is None:
        raise NotFoundError("Assembly not found.")
    changes = patch.model_dump(exclude_unset=True)
    before = {key: str(getattr(row, key)) for key in changes}
    for key, value in changes.items():
        setattr(row, key, value)
    row.version += 1
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="assembly",
        entity_id=uuid.uuid5(uuid.NAMESPACE_URL, f"assembly:{code}"),
        action="catalog_update",
        before=before,
        after={key: str(value) for key, value in changes.items()} | {"version": row.version},
    )
    db.commit()
    db.refresh(row)
    return _assembly_out(row)


@router.get("/modifiers")
def list_modifiers(ctx: Ctx, db: Db) -> ModifierList:
    rows = db.scalars(select(Modifier).order_by(Modifier.code))
    return ModifierList(
        items=[ModifierOut.model_validate(row, from_attributes=True) for row in rows]
    )


@router.get("/materials")
def list_materials(
    ctx: Ctx,
    db: Db,
    q: Annotated[str | None, Query(max_length=100)] = None,
) -> MaterialList:
    stmt = select(MaterialItem).order_by(MaterialItem.sku)
    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(MaterialItem.sku.ilike(pattern) | MaterialItem.description.ilike(pattern))
    return MaterialList(
        items=[MaterialOut.model_validate(row, from_attributes=True) for row in db.scalars(stmt)]
    )
