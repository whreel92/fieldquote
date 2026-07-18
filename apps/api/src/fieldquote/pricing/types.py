"""Pricing engine input/output types.

The engine is PURE: everything it needs (catalog snapshot, company rates,
request) is passed in; it performs no I/O. All money and hours are Decimal.
Models are frozen so a request can never be mutated mid-pricing.
"""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Tier = Literal["good", "better", "best"]

ZERO = Decimal("0")
ONE = Decimal("1")


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True)


# ── Catalog snapshot ─────────────────────────────────────────────────────────


class BomLine(_Frozen):
    sku: str
    qty: Decimal = Field(gt=ZERO)


class OptionTier(_Frozen):
    """A good/better/best variant. A tier fully REPLACES the assembly's base
    labor_hours/helper_hours/bom — it is not a delta."""

    tier: Tier
    label: str
    labor_hours: Decimal = Field(ge=ZERO)
    helper_hours: Decimal = Field(default=ZERO, ge=ZERO)
    bom: tuple[BomLine, ...] = ()


class CatalogAssembly(_Frozen):
    code: str
    name: str
    description: str = ""
    unit: str = "ea"
    labor_hours: Decimal = Field(ge=ZERO)
    helper_hours: Decimal = Field(default=ZERO, ge=ZERO)
    bom: tuple[BomLine, ...] = ()
    modifiers_allowed: tuple[str, ...] = ()
    option_tiers: tuple[OptionTier, ...] = ()
    status: Literal["draft", "advisor_approved"] = "draft"


class CatalogMaterial(_Frozen):
    sku: str
    description: str
    unit: str = "ea"
    base_price: Decimal = Field(ge=ZERO)
    region_multipliers: dict[str, Decimal] = Field(default_factory=dict)


class ModifierEffect(_Frozen):
    """Effect on a line. Multiplicative effects apply before additive ones
    (see ADR-0005)."""

    labor_hours_mult: Decimal = Field(default=ONE, ge=ZERO)
    labor_hours_add: Decimal = Field(default=ZERO, ge=ZERO)
    material_mult: Decimal = Field(default=ONE, ge=ZERO)


class CatalogModifier(_Frozen):
    code: str
    name: str
    effect: ModifierEffect


class Catalog(_Frozen):
    assemblies: dict[str, CatalogAssembly]
    materials: dict[str, CatalogMaterial]
    modifiers: dict[str, CatalogModifier]

    @classmethod
    def build(
        cls,
        assemblies: list[CatalogAssembly],
        materials: list[CatalogMaterial],
        modifiers: list[CatalogModifier],
    ) -> "Catalog":
        return cls(
            assemblies={a.code: a for a in assemblies},
            materials={m.sku: m for m in materials},
            modifiers={m.code: m for m in modifiers},
        )


# ── Company rates & request ──────────────────────────────────────────────────


class CompanyRates(_Frozen):
    labor_rate: Decimal = Field(ge=ZERO)
    helper_rate: Decimal | None = Field(default=None, ge=ZERO)
    target_margin_pct: Decimal = Field(default=ZERO, ge=ZERO)
    tax_rate_pct: Decimal = Field(default=ZERO, ge=ZERO)
    markup_model: Literal["margin", "markup"] = "margin"
    job_minimum: Decimal = Field(default=ZERO, ge=ZERO)
    margin_floor_pct: Decimal = Field(default=ZERO, ge=ZERO)
    # Phase 9 feedback loop: per-assembly labor-hour multipliers learned from
    # a company's actuals ({assembly_code: multiplier}).
    assembly_labor_overrides: dict[str, Decimal] = Field(default_factory=dict)


class RequestLine(_Frozen):
    code: str
    qty: Decimal = Field(default=ONE, gt=ZERO)
    modifiers: tuple[str, ...] = ()
    # Only meaningful for assemblies with option_tiers; defaults to "good".
    selected_tier: Tier | None = None


class AllowanceLine(_Frozen):
    description: str
    amount: Decimal = Field(ge=ZERO)
    reason: str = ""


class Adjustments(_Frozen):
    discount: Decimal = Field(default=ZERO, ge=ZERO)
    margin_override_pct: Decimal | None = Field(default=None, ge=ZERO)


class PricingRequest(_Frozen):
    assemblies: tuple[RequestLine, ...] = ()
    allowances: tuple[AllowanceLine, ...] = ()
    company_rates: CompanyRates
    region: str = "default"
    adjustments: Adjustments = Adjustments()


# ── Output ───────────────────────────────────────────────────────────────────


class MaterialBreakdownItem(_Frozen):
    sku: str
    description: str
    unit_price: Decimal  # region-adjusted, rounded to cents
    qty: Decimal  # bom qty x line qty
    extended: Decimal


class ModifierApplication(_Frozen):
    code: str
    name: str
    kind: Literal["multiply", "add"]
    hours_before: Decimal
    hours_after: Decimal


class LineBreakdown(_Frozen):
    """The 'show the math' payload for the estimate editor."""

    base_labor_hours: Decimal  # per unit, after company override
    company_override_mult: Decimal
    modifier_applications: tuple[ModifierApplication, ...]
    unit_labor_hours: Decimal  # per unit, after modifiers
    total_labor_hours: Decimal
    total_helper_hours: Decimal
    labor_rate: Decimal
    helper_rate: Decimal
    labor_cost: Decimal
    helper_cost: Decimal
    materials: tuple[MaterialBreakdownItem, ...]
    material_cost: Decimal
    cost_total: Decimal
    pricing_model: Literal["margin", "markup"]
    pct_applied: Decimal


LineType = Literal[
    "standard",
    "allowance",
    "verify",
    "option_good",
    "option_better",
    "option_best",
    "discount",
]


class PricedLine(_Frozen):
    position: int
    assembly_code: str | None
    description: str
    qty: Decimal
    unit: str
    line_type: LineType
    price_source: Literal["engine", "manual", "pricebook"] = "engine"
    confidence: Literal["known", "allowance", "verify"] = "known"
    unit_price: Decimal
    total: Decimal
    material_cost: Decimal
    labor_hours: Decimal
    labor_rate: Decimal
    # Option-tier lines that are not the selected tier are excluded from totals.
    included: bool = True
    editable_note: str = ""
    breakdown: LineBreakdown | None = None


class MarginCheck(_Frozen):
    cost_total: Decimal
    price_basis: Decimal  # included, cost-bearing lines (allowances excluded)
    effective_margin_pct: Decimal
    target_margin_pct: Decimal
    below_target: bool
    below_floor: bool


class PricedEstimate(_Frozen):
    engine_version: str
    lines: tuple[PricedLine, ...]
    subtotal_material: Decimal
    subtotal_labor: Decimal
    subtotal: Decimal  # all included lines, pre-tax
    tax: Decimal
    total: Decimal
    margin_check: MarginCheck
