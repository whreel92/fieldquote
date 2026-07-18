"""THE deterministic pricing engine.

Pure function of (PricingRequest, Catalog) -> PricedEstimate. No I/O, no
clock, no randomness: identical input yields byte-identical output.

Order of operations (ADR-0005) — any change here requires a golden-file
snapshot-update commit with rationale:

 1. Validate every assembly code, modifier code, tier selection and BOM SKU
    against the catalog. Unknowns raise typed PricingError subclasses.
 2. Material unit price = base_price x region multiplier (1 if the region is
    absent from the SKU's map), rounded HALF_UP to cents. Extended =
    unit price x bom qty x line qty, rounded to cents.
 3. Labor hours per unit = assembly hours x company override multiplier,
    then ALL multiplicative modifier effects (in request order), then ALL
    additive effects (in request order). Hours round HALF_UP to 0.01.
 4. Labor cost = total hours x labor rate; helper cost = helper hours x
    helper rate (falls back to labor rate). Each rounded to cents.
 5. Line cost = materials + labor + helper. Price by company model:
    margin  -> cost / (1 - pct/100)   (pct must be < 100)
    markup  -> cost x (1 + pct/100)
    pct = adjustments.margin_override_pct if set, else target_margin_pct.
    Line totals round to cents; line-level rounding is authoritative and
    totals are sums of rounded lines.
 6. Assemblies with option_tiers expand to one line per tier; only the
    selected tier (default "good") is included in totals. A tier fully
    replaces base hours/BOM.
 7. Allowance lines pass through at their fixed amount — no margin, no
    modifiers, confidence "allowance".
 8. Discount (if any) applies after all lines, capped at the running
    subtotal so the subtotal can never go negative.
 9. Job minimum: if the post-discount subtotal is below the company job
    minimum, a "Minimum job charge" line tops it up to exactly the minimum.
10. Tax = subtotal x tax_rate_pct, rounded to cents. Total = subtotal + tax.
11. Margin check compares cost-bearing lines only (allowances excluded from
    the price basis) against target and floor percentages.
"""

from decimal import ROUND_HALF_UP, Decimal

from fieldquote.pricing.errors import (
    InvalidMarginError,
    ModifierNotAllowedError,
    TierNotAvailableError,
    UnknownAssemblyError,
    UnknownModifierError,
    UnknownSkuError,
)
from fieldquote.pricing.types import (
    ONE,
    ZERO,
    BomLine,
    Catalog,
    CatalogAssembly,
    CompanyRates,
    LineBreakdown,
    MarginCheck,
    MaterialBreakdownItem,
    ModifierApplication,
    PricedEstimate,
    PricedLine,
    PricingRequest,
    RequestLine,
    Tier,
)

ENGINE_VERSION = "2.0.0"

CENT = Decimal("0.01")
HOUR_STEP = Decimal("0.01")
PCT_STEP = Decimal("0.1")
HUNDRED = Decimal("100")


def _money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _hours(value: Decimal) -> Decimal:
    return value.quantize(HOUR_STEP, rounding=ROUND_HALF_UP)


def _materials(
    catalog: Catalog,
    bom: tuple[BomLine, ...],
    region: str,
    line_qty: Decimal,
    assembly_code: str,
) -> tuple[tuple[MaterialBreakdownItem, ...], Decimal]:
    items: list[MaterialBreakdownItem] = []
    total = ZERO
    for bom_line in bom:
        sku = bom_line.sku
        bom_qty = bom_line.qty
        material = catalog.materials.get(sku)
        if material is None:
            raise UnknownSkuError(sku, assembly_code)
        multiplier = material.region_multipliers.get(region, ONE)
        unit_price = _money(material.base_price * multiplier)
        qty = bom_qty * line_qty
        extended = _money(unit_price * qty)
        items.append(
            MaterialBreakdownItem(
                sku=sku,
                description=material.description,
                unit_price=unit_price,
                qty=qty,
                extended=extended,
            )
        )
        total += extended
    return tuple(items), _money(total)


def _labor_hours(
    base_hours: Decimal,
    override_mult: Decimal,
    modifiers: tuple[str, ...],
    catalog: Catalog,
    assembly: CatalogAssembly,
) -> tuple[Decimal, Decimal, tuple[ModifierApplication, ...]]:
    """Returns (base after override, per-unit hours after modifiers, trace)."""
    base = _hours(base_hours * override_mult)
    hours = base
    applications: list[ModifierApplication] = []
    resolved = []
    for code in modifiers:
        modifier = catalog.modifiers.get(code)
        if modifier is None:
            raise UnknownModifierError(code)
        if code not in assembly.modifiers_allowed:
            raise ModifierNotAllowedError(code, assembly.code)
        resolved.append(modifier)
    # Multiplicative first, then additive (ADR-0005 step 3).
    for modifier in resolved:
        if modifier.effect.labor_hours_mult != ONE:
            before = hours
            hours = _hours(hours * modifier.effect.labor_hours_mult)
            applications.append(
                ModifierApplication(
                    code=modifier.code,
                    name=modifier.name,
                    kind="multiply",
                    hours_before=before,
                    hours_after=hours,
                )
            )
    for modifier in resolved:
        if modifier.effect.labor_hours_add != ZERO:
            before = hours
            hours = _hours(hours + modifier.effect.labor_hours_add)
            applications.append(
                ModifierApplication(
                    code=modifier.code,
                    name=modifier.name,
                    kind="add",
                    hours_before=before,
                    hours_after=hours,
                )
            )
    return base, hours, tuple(applications)


def _material_mult(modifiers: tuple[str, ...], catalog: Catalog) -> Decimal:
    # Codes were validated in _labor_hours before this runs.
    mult = ONE
    for code in modifiers:
        mult *= catalog.modifiers[code].effect.material_mult
    return mult


def _apply_model(cost: Decimal, pct: Decimal, model: str) -> Decimal:
    if model == "margin":
        if pct >= HUNDRED:
            raise InvalidMarginError(pct)
        return _money(cost / (ONE - pct / HUNDRED))
    return _money(cost * (ONE + pct / HUNDRED))


def _price_component(
    catalog: Catalog,
    rates: CompanyRates,
    region: str,
    line: RequestLine,
    assembly: CatalogAssembly,
    *,
    labor_hours: Decimal,
    helper_hours: Decimal,
    bom: tuple[BomLine, ...],
    pct: Decimal,
) -> tuple[Decimal, Decimal, Decimal, Decimal, LineBreakdown]:
    """Price one cost-bearing component (base assembly or one option tier).

    Returns (total, cost, material_cost, total_labor_hours, breakdown).
    """
    override_mult = rates.assembly_labor_overrides.get(assembly.code, ONE)
    base, unit_hours, applications = _labor_hours(
        labor_hours, override_mult, line.modifiers, catalog, assembly
    )
    total_hours = _hours(unit_hours * line.qty)
    total_helper = _hours(helper_hours * line.qty)
    helper_rate = rates.helper_rate if rates.helper_rate is not None else rates.labor_rate
    labor_cost = _money(total_hours * rates.labor_rate)
    helper_cost = _money(total_helper * helper_rate)

    materials, material_cost = _materials(catalog, bom, region, line.qty, assembly.code)
    material_mult = _material_mult(line.modifiers, catalog)
    if material_mult != ONE:
        material_cost = _money(material_cost * material_mult)

    cost = material_cost + labor_cost + helper_cost
    total = _apply_model(cost, pct, rates.markup_model)
    breakdown = LineBreakdown(
        base_labor_hours=base,
        company_override_mult=override_mult,
        modifier_applications=applications,
        unit_labor_hours=unit_hours,
        total_labor_hours=total_hours,
        total_helper_hours=total_helper,
        labor_rate=rates.labor_rate,
        helper_rate=helper_rate,
        labor_cost=labor_cost,
        helper_cost=helper_cost,
        materials=materials,
        material_cost=material_cost,
        cost_total=cost,
        pricing_model=rates.markup_model,
        pct_applied=pct,
    )
    return total, cost, material_cost, total_hours, breakdown


def price(request: PricingRequest, catalog: Catalog) -> PricedEstimate:
    rates = request.company_rates
    pct = (
        request.adjustments.margin_override_pct
        if request.adjustments.margin_override_pct is not None
        else rates.target_margin_pct
    )

    lines: list[PricedLine] = []
    position = 0
    cost_total = ZERO
    price_basis = ZERO  # included cost-bearing price (for margin check)
    subtotal = ZERO
    subtotal_material = ZERO
    subtotal_labor = ZERO

    for line in request.assemblies:
        assembly = catalog.assemblies.get(line.code)
        if assembly is None:
            raise UnknownAssemblyError(line.code)

        if assembly.option_tiers:
            selected: Tier = line.selected_tier or "good"
            available = {t.tier for t in assembly.option_tiers}
            if selected not in available:
                raise TierNotAvailableError(selected, assembly.code)
            for tier in assembly.option_tiers:
                total, cost, material_cost, hours, breakdown = _price_component(
                    catalog,
                    rates,
                    request.region,
                    line,
                    assembly,
                    labor_hours=tier.labor_hours,
                    helper_hours=tier.helper_hours,
                    bom=tier.bom,
                    pct=pct,
                )
                included = tier.tier == selected
                lines.append(
                    PricedLine(
                        position=position,
                        assembly_code=assembly.code,
                        description=f"{assembly.name} — {tier.label}",
                        qty=line.qty,
                        unit=assembly.unit,
                        line_type=f"option_{tier.tier}",
                        unit_price=_money(total / line.qty),
                        total=total,
                        material_cost=material_cost,
                        labor_hours=hours,
                        labor_rate=rates.labor_rate,
                        included=included,
                        breakdown=breakdown,
                    )
                )
                position += 1
                if included:
                    cost_total += cost
                    price_basis += total
                    subtotal += total
                    subtotal_material += material_cost
                    subtotal_labor += breakdown.labor_cost + breakdown.helper_cost
        else:
            if line.selected_tier is not None:
                raise TierNotAvailableError(line.selected_tier, assembly.code)
            total, cost, material_cost, hours, breakdown = _price_component(
                catalog,
                rates,
                request.region,
                line,
                assembly,
                labor_hours=assembly.labor_hours,
                helper_hours=assembly.helper_hours,
                bom=assembly.bom,
                pct=pct,
            )
            lines.append(
                PricedLine(
                    position=position,
                    assembly_code=assembly.code,
                    description=assembly.name,
                    qty=line.qty,
                    unit=assembly.unit,
                    line_type="standard",
                    unit_price=_money(total / line.qty),
                    total=total,
                    material_cost=material_cost,
                    labor_hours=hours,
                    labor_rate=rates.labor_rate,
                    breakdown=breakdown,
                )
            )
            position += 1
            cost_total += cost
            price_basis += total
            subtotal += total
            subtotal_material += material_cost
            subtotal_labor += breakdown.labor_cost + breakdown.helper_cost

    for allowance in request.allowances:
        amount = _money(allowance.amount)
        lines.append(
            PricedLine(
                position=position,
                assembly_code=None,
                description=allowance.description,
                qty=ONE,
                unit="ea",
                line_type="allowance",
                confidence="allowance",
                unit_price=amount,
                total=amount,
                material_cost=ZERO,
                labor_hours=ZERO,
                labor_rate=rates.labor_rate,
                editable_note=allowance.reason,
            )
        )
        position += 1
        subtotal += amount

    if request.adjustments.discount > ZERO:
        discount = min(_money(request.adjustments.discount), subtotal)
        lines.append(
            PricedLine(
                position=position,
                assembly_code=None,
                description="Discount",
                qty=ONE,
                unit="ea",
                line_type="discount",
                unit_price=-discount,
                total=-discount,
                material_cost=ZERO,
                labor_hours=ZERO,
                labor_rate=rates.labor_rate,
            )
        )
        position += 1
        subtotal -= discount
        price_basis -= discount

    if rates.job_minimum > ZERO and subtotal < rates.job_minimum:
        top_up = _money(rates.job_minimum - subtotal)
        lines.append(
            PricedLine(
                position=position,
                assembly_code=None,
                description="Minimum job charge",
                qty=ONE,
                unit="ea",
                line_type="standard",
                unit_price=top_up,
                total=top_up,
                material_cost=ZERO,
                labor_hours=ZERO,
                labor_rate=rates.labor_rate,
                editable_note="Applied to meet the company job minimum.",
            )
        )
        position += 1
        subtotal += top_up
        price_basis += top_up

    subtotal = _money(subtotal)
    tax = _money(subtotal * rates.tax_rate_pct / HUNDRED)
    total_amount = _money(subtotal + tax)

    price_basis = _money(price_basis)
    if price_basis > ZERO:
        effective = ((price_basis - cost_total) / price_basis * HUNDRED).quantize(
            PCT_STEP, rounding=ROUND_HALF_UP
        )
    else:
        effective = ZERO
    margin_check = MarginCheck(
        cost_total=_money(cost_total),
        price_basis=price_basis,
        effective_margin_pct=effective,
        target_margin_pct=rates.target_margin_pct,
        below_target=effective < rates.target_margin_pct,
        below_floor=rates.margin_floor_pct > ZERO and effective < rates.margin_floor_pct,
    )

    return PricedEstimate(
        engine_version=ENGINE_VERSION,
        lines=tuple(lines),
        subtotal_material=_money(subtotal_material),
        subtotal_labor=_money(subtotal_labor),
        subtotal=subtotal,
        tax=tax,
        total=total_amount,
        margin_check=margin_check,
    )
