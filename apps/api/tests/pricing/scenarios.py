"""The golden scenario matrix: ≥40 named PricingRequest payloads against the
hand-authored fixture catalog. Each is pinned byte-for-byte in golden/*.json."""

from typing import Any

BASE_RATES: dict[str, Any] = {"labor_rate": "100", "target_margin_pct": "50"}


def _rates(**overrides: Any) -> dict[str, Any]:
    return {**BASE_RATES, **overrides}


def _req(
    assemblies: list[dict[str, Any]],
    rates: dict[str, Any] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    return {"assemblies": assemblies, "company_rates": rates or dict(BASE_RATES), **extra}


CIRCUIT = {"code": "circuit_20a"}
PANEL = {"code": "panel_200a"}
RECESSED = {"code": "recessed_led"}

SCENARIOS: dict[str, dict[str, Any]] = {
    # ── basics ──────────────────────────────────────────────────────────
    "single_circuit_margin50": _req([dict(CIRCUIT)]),
    "single_circuit_margin0": _req([dict(CIRCUIT)], _rates(target_margin_pct="0")),
    "single_circuit_margin65": _req([dict(CIRCUIT)], _rates(target_margin_pct="65")),
    "single_circuit_markup50": _req([dict(CIRCUIT)], _rates(markup_model="markup")),
    "single_circuit_markup25": _req(
        [dict(CIRCUIT)], _rates(markup_model="markup", target_margin_pct="25")
    ),
    "qty_2": _req([dict(CIRCUIT, qty="2")]),
    "qty_fractional": _req([dict(CIRCUIT, qty="1.5")]),
    "qty_large": _req([dict(CIRCUIT, qty="12")]),
    "high_labor_rate": _req([dict(CIRCUIT)], _rates(labor_rate="245")),
    "odd_labor_rate_rounding": _req([dict(CIRCUIT, qty="3")], _rates(labor_rate="33.33")),
    # ── regions ─────────────────────────────────────────────────────────
    "region_west": _req([dict(CIRCUIT)], region="west"),
    "region_unknown_defaults_to_1x": _req([dict(CIRCUIT)], region="southeast"),
    # ── modifiers ───────────────────────────────────────────────────────
    "modifier_mult_only": _req([dict(CIRCUIT, modifiers=["stucco_exterior"])]),
    "modifier_add_only": _req([dict(CIRCUIT, modifiers=["attic_run"])]),
    "modifier_mult_then_add": _req([dict(CIRCUIT, modifiers=["stucco_exterior", "attic_run"])]),
    "modifier_request_order_irrelevant": _req(
        [dict(CIRCUIT, modifiers=["attic_run", "stucco_exterior"])]
    ),
    "modifier_material_mult": _req([dict(CIRCUIT, modifiers=["long_run"])]),
    "modifier_all_three": _req(
        [dict(CIRCUIT, modifiers=["stucco_exterior", "attic_run", "long_run"])]
    ),
    "modifier_with_qty3": _req([dict(CIRCUIT, qty="3", modifiers=["stucco_exterior"])]),
    # ── helper split ────────────────────────────────────────────────────
    "helper_rate_set": _req([dict(PANEL)], _rates(helper_rate="80", target_margin_pct="30")),
    "helper_rate_fallback": _req([dict(PANEL)], _rates(target_margin_pct="30")),
    "helper_with_modifier": _req(
        [dict(PANEL, modifiers=["stucco_exterior"])],
        _rates(helper_rate="65", target_margin_pct="42.5"),
    ),
    # ── option tiers ────────────────────────────────────────────────────
    "tiers_default_good": _req([dict(RECESSED)]),
    "tiers_select_better": _req([dict(RECESSED, selected_tier="better")]),
    "tiers_select_best": _req([dict(RECESSED, selected_tier="best")]),
    "tiers_qty6": _req([dict(RECESSED, qty="6", selected_tier="better")]),
    "tiers_alongside_standard_lines": _req([dict(CIRCUIT), dict(RECESSED, selected_tier="best")]),
    # ── allowances ──────────────────────────────────────────────────────
    "allowance_only": _req([], allowances=[{"description": "Load calc", "amount": "350"}]),
    "allowance_with_line": _req(
        [dict(CIRCUIT)],
        allowances=[{"description": "Load calc", "amount": "350", "reason": "panel not opened"}],
    ),
    "allowance_multiple": _req(
        [dict(CIRCUIT)],
        allowances=[
            {"description": "Permit fees", "amount": "150"},
            {"description": "Drywall patch", "amount": "275.50"},
        ],
    ),
    "allowance_zero_amount": _req([], allowances=[{"description": "TBD", "amount": "0"}]),
    # ── discount ────────────────────────────────────────────────────────
    "discount_partial": _req([dict(CIRCUIT)], adjustments={"discount": "100"}),
    "discount_capped_at_subtotal": _req([dict(CIRCUIT)], adjustments={"discount": "99999"}),
    "discount_exact_subtotal": _req([dict(CIRCUIT)], adjustments={"discount": "525"}),
    # ── job minimum ─────────────────────────────────────────────────────
    "minimum_tops_up": _req([dict(RECESSED)], _rates(job_minimum="450")),
    "minimum_already_met": _req([dict(CIRCUIT)], _rates(job_minimum="450")),
    "minimum_with_discount_interaction": _req(
        [dict(CIRCUIT)], _rates(job_minimum="500"), adjustments={"discount": "100"}
    ),
    "minimum_empty_request": _req([], _rates(job_minimum="250")),
    # ── tax ─────────────────────────────────────────────────────────────
    "tax_flat": _req([dict(CIRCUIT)], _rates(tax_rate_pct="10")),
    "tax_odd_rate_rounding": _req([dict(CIRCUIT)], _rates(tax_rate_pct="8.25")),
    "tax_on_allowance_and_discount": _req(
        [dict(CIRCUIT)],
        _rates(tax_rate_pct="8.25"),
        allowances=[{"description": "Permit", "amount": "150"}],
        adjustments={"discount": "50"},
    ),
    # ── margin controls ─────────────────────────────────────────────────
    "margin_override": _req([dict(CIRCUIT)], adjustments={"margin_override_pct": "60"}),
    "margin_floor_flags": _req(
        [dict(CIRCUIT)],
        _rates(margin_floor_pct="40"),
        adjustments={"margin_override_pct": "30"},
    ),
    "assembly_labor_override": _req(
        [dict(CIRCUIT)], _rates(assembly_labor_overrides={"circuit_20a": "1.3"})
    ),
    # ── kitchen sink ────────────────────────────────────────────────────
    "kitchen_sink": _req(
        [
            dict(CIRCUIT, qty="2", modifiers=["stucco_exterior", "attic_run"]),
            dict(PANEL, modifiers=["stucco_exterior"]),
            dict(RECESSED, qty="6", selected_tier="best"),
        ],
        _rates(
            helper_rate="75",
            tax_rate_pct="8.25",
            job_minimum="500",
            margin_floor_pct="35",
            assembly_labor_overrides={"panel_200a": "1.1"},
        ),
        region="west",
        allowances=[{"description": "Permit + inspection", "amount": "425", "reason": "city fees"}],
        adjustments={"discount": "250"},
    ),
    "empty_request": _req([]),
}
