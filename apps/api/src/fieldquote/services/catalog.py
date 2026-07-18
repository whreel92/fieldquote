"""Catalog snapshot loading for the pricing engine.

The engine itself is pure; this service is the one place that reads catalog
rows from Postgres and converts them into `fieldquote.pricing` types.

PRODUCTION GUARD (§Phase 2.5): companies running in a production environment
may only price against `advisor_approved` assemblies unless the company has
the `dev_mode` setting enabled. Placeholder prices must never reach a real
customer.
"""

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.config import AppEnv, get_settings
from fieldquote.domain.models import Assembly, Company, CompanyRate, MaterialItem, Modifier
from fieldquote.pricing import (
    Catalog,
    CatalogAssembly,
    CatalogMaterial,
    CatalogModifier,
    CompanyRates,
    ModifierEffect,
)


def approved_only(company: Company) -> bool:
    """True when this company must be restricted to advisor-approved pricing."""
    settings = get_settings()
    dev_mode = bool(company.settings.get("dev_mode", False))
    return settings.app_env == AppEnv.production and not dev_mode


def _to_assembly(row: Assembly) -> CatalogAssembly:
    payload: dict[str, Any] = {
        "code": row.code,
        "name": row.name,
        "description": row.description or "",
        "unit": row.unit,
        "labor_hours": row.labor_hours,
        "helper_hours": row.helper_hours,
        "bom": row.bom,
        "modifiers_allowed": tuple(row.modifiers_allowed),
        "option_tiers": tuple(row.option_tiers) if row.option_tiers else (),
        "status": row.status,
    }
    return CatalogAssembly.model_validate(payload)


def load_catalog(db: Session, company: Company) -> Catalog:
    stmt = select(Assembly)
    if approved_only(company):
        stmt = stmt.where(Assembly.status == "advisor_approved")
    assemblies = [_to_assembly(row) for row in db.scalars(stmt)]
    materials = [
        CatalogMaterial(
            sku=row.sku,
            description=row.description,
            unit=row.unit,
            base_price=row.base_price,
            region_multipliers={k: Decimal(str(v)) for k, v in row.region_multipliers.items()},
        )
        for row in db.scalars(select(MaterialItem))
    ]
    modifiers = [
        CatalogModifier(
            code=row.code,
            name=row.name,
            effect=ModifierEffect.model_validate(row.effect),
        )
        for row in db.scalars(select(Modifier))
    ]
    return Catalog.build(assemblies=assemblies, materials=materials, modifiers=modifiers)


def load_company_rates(db: Session, company: Company) -> CompanyRates:
    row = db.get(CompanyRate, company.id)
    if row is None:
        return CompanyRates(labor_rate=Decimal("0"))
    overrides: dict[str, Any] = row.overrides or {}
    assembly_overrides = {
        str(code): Decimal(str(mult))
        for code, mult in dict(overrides.get("assembly_labor_mult", {})).items()
    }
    return CompanyRates(
        labor_rate=row.labor_rate,
        helper_rate=row.helper_rate,
        target_margin_pct=row.target_margin_pct,
        tax_rate_pct=row.tax_rate_pct,
        markup_model="markup" if row.markup_model == "markup" else "margin",
        job_minimum=Decimal(str(overrides.get("job_minimum", "0"))),
        margin_floor_pct=Decimal(str(overrides.get("margin_floor_pct", "0"))),
        assembly_labor_overrides=assembly_overrides,
    )


def company_region(company: Company) -> str:
    return str(company.settings.get("region", "default"))
