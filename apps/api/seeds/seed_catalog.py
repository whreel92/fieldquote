"""Load the placeholder electrical catalog (seeds/catalog/*.json) into the
global pricing tables. Idempotent upsert by primary key; every assembly is
seeded `status: draft` — the production guard keeps drafts away from real
customers until advisors approve them.

Usage: uv run python seeds/seed_catalog.py  (uses DATABASE_URL)
"""

import json
import os
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from fieldquote.core.config import get_settings
from fieldquote.domain.models import Assembly, MaterialItem, Modifier

CATALOG_DIR = Path(__file__).parent / "catalog"


def _load(name: str) -> list[dict[str, Any]]:
    with open(CATALOG_DIR / name, encoding="utf-8") as fh:
        data: list[dict[str, Any]] = json.load(fh)
    return data


def main() -> None:
    settings = get_settings()
    if settings.app_env == "production":
        raise SystemExit("Refusing to seed placeholder catalog data into production.")

    engine = create_engine(settings.database_url)
    materials = _load("materials.json")
    modifiers = _load("modifiers.json")
    assembly_files = sorted(CATALOG_DIR.glob("assemblies_*.json"))
    assemblies: list[dict[str, Any]] = []
    for path in assembly_files:
        assemblies.extend(_load(path.name))

    with Session(engine) as session:
        for item in materials:
            session.merge(
                MaterialItem(
                    sku=item["sku"],
                    description=item["description"],
                    unit=item["unit"],
                    category=item.get("category"),
                    base_price=Decimal(str(item["base_price"])),
                    price_asof=date.fromisoformat(item["price_asof"]),
                    source=item.get("source", "placeholder_v0"),
                    region_multipliers=item.get("region_multipliers", {}),
                )
            )
        for item in modifiers:
            session.merge(
                Modifier(
                    code=item["code"],
                    name=item["name"],
                    description=item.get("description"),
                    effect=item["effect"],
                )
            )
        for item in assemblies:
            existing = session.get(Assembly, item["code"])
            session.merge(
                Assembly(
                    code=item["code"],
                    trade="electrical",
                    name=item["name"],
                    description=item.get("description"),
                    job_type_codes=item["job_type_codes"],
                    unit=item.get("unit", "ea"),
                    labor_hours=Decimal(str(item["labor_hours"])),
                    helper_hours=Decimal(str(item.get("helper_hours", 0))),
                    labor_notes=item.get("labor_notes"),
                    bom=item.get("bom", []),
                    modifiers_allowed=item.get("modifiers_allowed", []),
                    option_tiers=item.get("option_tiers"),
                    # Never downgrade an advisor-approved assembly back to draft.
                    status=existing.status if existing is not None else "draft",
                    version=existing.version if existing is not None else 1,
                )
            )
        session.commit()

    print(
        f"Seeded {len(materials)} materials, {len(modifiers)} modifiers, "
        f"{len(assemblies)} assemblies from {len(assembly_files)} files."
    )


if __name__ == "__main__":
    main()
