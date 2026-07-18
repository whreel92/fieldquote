"""A small hand-authored catalog with hand-computed expectations in
test_engine.py. Kept separate from the real seed catalog on purpose: these
numbers are chosen so the arithmetic can be verified with a pencil."""

from decimal import Decimal

from fieldquote.pricing import (
    BomLine,
    Catalog,
    CatalogAssembly,
    CatalogMaterial,
    CatalogModifier,
    CompanyRates,
    ModifierEffect,
    OptionTier,
)

D = Decimal


def make_catalog() -> Catalog:
    return Catalog.build(
        assemblies=[
            CatalogAssembly(
                code="circuit_20a",
                name="20A dedicated circuit",
                labor_hours=D("2.0"),
                bom=(BomLine(sku="WIRE-123", qty=D("50")), BomLine(sku="BRKR-20A", qty=D("1"))),
                modifiers_allowed=("stucco_exterior", "attic_run", "long_run"),
            ),
            CatalogAssembly(
                code="panel_200a",
                name="200A panel upgrade",
                labor_hours=D("8.0"),
                helper_hours=D("4.0"),
                bom=(BomLine(sku="PANEL-200", qty=D("1")),),
                modifiers_allowed=("stucco_exterior",),
            ),
            CatalogAssembly(
                code="recessed_led",
                name="Recessed LED lighting",
                labor_hours=D("1.0"),
                modifiers_allowed=(),
                option_tiers=(
                    OptionTier(tier="good", label="Standard 4\"", labor_hours=D("1.0")),
                    OptionTier(tier="better", label="Gimbal 4\"", labor_hours=D("1.5")),
                    OptionTier(
                        tier="best",
                        label="Smart RGBW",
                        labor_hours=D("2.0"),
                        bom=(BomLine(sku="BRKR-20A", qty=D("1")),),
                    ),
                ),
            ),
            CatalogAssembly(
                code="two_tier_only",
                name="Two-tier assembly",
                labor_hours=D("1.0"),
                option_tiers=(
                    OptionTier(tier="good", label="Good", labor_hours=D("1.0")),
                    OptionTier(tier="better", label="Better", labor_hours=D("2.0")),
                ),
            ),
            CatalogAssembly(
                code="bad_bom",
                name="Assembly with a BOM SKU missing from materials",
                labor_hours=D("1.0"),
                bom=(BomLine(sku="NOPE-404", qty=D("1")),),
            ),
        ],
        materials=[
            CatalogMaterial(
                sku="WIRE-123",
                description="12/2 NM-B per ft",
                unit="ft",
                base_price=D("1.00"),
                region_multipliers={"west": D("1.25")},
            ),
            CatalogMaterial(sku="BRKR-20A", description="20A breaker", base_price=D("12.50")),
            CatalogMaterial(sku="PANEL-200", description="200A panel", base_price=D("350.00")),
        ],
        modifiers=[
            CatalogModifier(
                code="stucco_exterior",
                name="Stucco exterior",
                effect=ModifierEffect(labor_hours_mult=D("1.25")),
            ),
            CatalogModifier(
                code="attic_run",
                name="Attic run",
                effect=ModifierEffect(labor_hours_add=D("0.5")),
            ),
            CatalogModifier(
                code="long_run",
                name="Long wire run",
                effect=ModifierEffect(material_mult=D("1.5")),
            ),
        ],
    )


def rates(**overrides: object) -> CompanyRates:
    defaults: dict[str, object] = {
        "labor_rate": D("100"),
        "target_margin_pct": D("50"),
    }
    defaults.update(overrides)
    return CompanyRates.model_validate(defaults)
