"""Hand-computed pricing engine tests. Every expected number here was worked
out by hand from ADR-0005 — these are the ground truth the golden files pin."""

from decimal import Decimal

import pytest

from fieldquote.pricing import (
    Adjustments,
    AllowanceLine,
    CompanyRates,
    InvalidMarginError,
    ModifierNotAllowedError,
    PricingRequest,
    RequestLine,
    TierNotAvailableError,
    UnknownAssemblyError,
    UnknownModifierError,
    UnknownSkuError,
    price,
)
from tests.pricing.catalog_fixture import make_catalog, rates

D = Decimal
CATALOG = make_catalog()


def req(**kwargs: object) -> PricingRequest:
    kwargs.setdefault("company_rates", rates())
    return PricingRequest.model_validate(kwargs)


def test_single_line_margin_model() -> None:
    # materials 50x1.00 + 12.50 = 62.50; labor 2.0h x 100 = 200; cost 262.50
    # margin 50% -> 262.50 / 0.5 = 525.00
    result = price(req(assemblies=[{"code": "circuit_20a"}]), CATALOG)
    line = result.lines[0]
    assert line.total == D("525.00")
    assert line.material_cost == D("62.50")
    assert line.labor_hours == D("2.00")
    assert result.subtotal == D("525.00")
    assert result.subtotal_material == D("62.50")
    assert result.subtotal_labor == D("200.00")
    assert result.tax == D("0.00")
    assert result.total == D("525.00")
    assert result.margin_check.effective_margin_pct == D("50.0")
    assert not result.margin_check.below_target
    assert line.breakdown is not None
    assert line.breakdown.cost_total == D("262.50")


def test_markup_model() -> None:
    # cost 262.50 x 1.5 = 393.75
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        company_rates=rates(markup_model="markup"),
    )
    assert price(r, CATALOG).total == D("393.75")


def test_region_multiplier() -> None:
    # wire unit 1.00 x 1.25 = 1.25 -> 50 x 1.25 = 62.50; + 12.50 = 75.00
    # cost 275 -> 550.00 at 50% margin
    r = req(assemblies=[{"code": "circuit_20a"}], region="west")
    result = price(r, CATALOG)
    assert result.lines[0].material_cost == D("75.00")
    assert result.total == D("550.00")


def test_modifiers_mult_then_add_qty2() -> None:
    # base 2.0 -> x1.25 = 2.5 -> +0.5 = 3.0/unit; qty 2 -> 6.0h -> 600 labor
    # materials qty2 = 125.00; cost 725 -> 1450.00
    r = req(
        assemblies=[
            {"code": "circuit_20a", "qty": 2, "modifiers": ["stucco_exterior", "attic_run"]}
        ]
    )
    result = price(r, CATALOG)
    line = result.lines[0]
    assert line.labor_hours == D("6.00")
    assert line.total == D("1450.00")
    assert line.breakdown is not None
    kinds = [a.kind for a in line.breakdown.modifier_applications]
    assert kinds == ["multiply", "add"]


def test_modifier_order_in_request_does_not_matter_for_mult_vs_add() -> None:
    # listed add-first: engine still applies multiplicative before additive
    r = req(
        assemblies=[
            {"code": "circuit_20a", "qty": 2, "modifiers": ["attic_run", "stucco_exterior"]}
        ]
    )
    assert price(r, CATALOG).lines[0].labor_hours == D("6.00")


def test_material_mult_modifier() -> None:
    # 62.50 x 1.5 = 93.75; labor 200; cost 293.75 -> 587.50
    r = req(assemblies=[{"code": "circuit_20a", "modifiers": ["long_run"]}])
    result = price(r, CATALOG)
    assert result.lines[0].material_cost == D("93.75")
    assert result.total == D("587.50")


def test_helper_rate_split() -> None:
    # labor 8x100=800; helper 4x80=320; material 350; cost 1470 -> /0.7 = 2100.00
    r = req(
        assemblies=[{"code": "panel_200a"}],
        company_rates=rates(helper_rate=D("80"), target_margin_pct=D("30")),
    )
    assert price(r, CATALOG).total == D("2100.00")


def test_helper_rate_falls_back_to_labor_rate() -> None:
    # helper 4x100=400; cost 1550 -> /0.7 = 2214.2857... -> 2214.29
    r = req(
        assemblies=[{"code": "panel_200a"}],
        company_rates=rates(target_margin_pct=D("30")),
    )
    assert price(r, CATALOG).total == D("2214.29")


def test_option_tiers_default_good_included() -> None:
    result = price(req(assemblies=[{"code": "recessed_led"}]), CATALOG)
    assert [line.line_type for line in result.lines] == [
        "option_good",
        "option_better",
        "option_best",
    ]
    assert [line.included for line in result.lines] == [True, False, False]
    # good: 1.0h x100 = 100 cost -> 200.00 at 50% margin
    assert result.subtotal == D("200.00")


def test_option_tiers_select_best() -> None:
    # best: 2.0h x100 + 12.50 = 212.50 -> 425.00
    r = req(assemblies=[{"code": "recessed_led", "selected_tier": "best"}])
    result = price(r, CATALOG)
    assert [line.included for line in result.lines] == [False, False, True]
    assert result.subtotal == D("425.00")
    assert result.margin_check.effective_margin_pct == D("50.0")


def test_tier_not_available() -> None:
    r = req(assemblies=[{"code": "two_tier_only", "selected_tier": "best"}])
    with pytest.raises(TierNotAvailableError):
        price(r, CATALOG)


def test_selected_tier_on_non_tiered_assembly_rejected() -> None:
    r = req(assemblies=[{"code": "circuit_20a", "selected_tier": "good"}])
    with pytest.raises(TierNotAvailableError):
        price(r, CATALOG)


def test_allowance_passthrough_and_margin_exclusion() -> None:
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        allowances=[{"description": "Load calc", "amount": "350", "reason": "not visible"}],
    )
    result = price(r, CATALOG)
    allowance = result.lines[1]
    assert allowance.line_type == "allowance"
    assert allowance.confidence == "allowance"
    assert allowance.total == D("350.00")
    assert result.subtotal == D("875.00")
    # margin check ignores the allowance: still exactly 50%
    assert result.margin_check.price_basis == D("525.00")
    assert result.margin_check.effective_margin_pct == D("50.0")


def test_discount_applied_and_capped() -> None:
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        adjustments={"discount": "100"},
    )
    assert price(r, CATALOG).subtotal == D("425.00")

    capped = req(
        assemblies=[{"code": "circuit_20a"}],
        adjustments={"discount": "9999"},
    )
    result = price(capped, CATALOG)
    assert result.subtotal == D("0.00")
    assert result.total == D("0.00")


def test_job_minimum_top_up() -> None:
    # margin 0 -> price = cost = 262.50; minimum 300 -> top up 37.50
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        company_rates=rates(target_margin_pct=D("0"), job_minimum=D("300")),
    )
    result = price(r, CATALOG)
    top_up = result.lines[-1]
    assert top_up.description == "Minimum job charge"
    assert top_up.total == D("37.50")
    assert result.subtotal == D("300.00")


def test_job_minimum_not_applied_when_met() -> None:
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        company_rates=rates(job_minimum=D("300")),
    )
    result = price(r, CATALOG)
    assert len(result.lines) == 1
    assert result.subtotal == D("525.00")


def test_tax() -> None:
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        company_rates=rates(tax_rate_pct=D("10")),
    )
    result = price(r, CATALOG)
    assert result.tax == D("52.50")
    assert result.total == D("577.50")


def test_margin_override() -> None:
    # 262.50 / 0.4 = 656.25
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        adjustments={"margin_override_pct": "60"},
    )
    assert price(r, CATALOG).total == D("656.25")


def test_margin_100_or_more_rejected() -> None:
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        company_rates=rates(target_margin_pct=D("100")),
    )
    with pytest.raises(InvalidMarginError):
        price(r, CATALOG)


def test_assembly_labor_override_multiplier() -> None:
    # Phase 9 hook: 2.0 x 1.5 = 3.0h -> labor 300; cost 362.50 -> 725.00
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        company_rates=rates(assembly_labor_overrides={"circuit_20a": D("1.5")}),
    )
    result = price(r, CATALOG)
    assert result.lines[0].labor_hours == D("3.00")
    assert result.total == D("725.00")


def test_below_target_and_floor_flags() -> None:
    # effective 30% (markup 42.857..%?) — use margin_override 30 with target 50
    r = req(
        assemblies=[{"code": "circuit_20a"}],
        company_rates=rates(target_margin_pct=D("50"), margin_floor_pct=D("40")),
        adjustments={"margin_override_pct": "30"},
    )
    check = price(r, CATALOG).margin_check
    assert check.effective_margin_pct == D("30.0")
    assert check.below_target
    assert check.below_floor


def test_empty_request() -> None:
    result = price(req(), CATALOG)
    assert result.lines == ()
    assert result.total == D("0.00")
    assert result.margin_check.effective_margin_pct == D("0")


def test_unit_price_display_rounding() -> None:
    # qty 3, margin 0: cost/line total = 3x(62.50 + 200) = 787.50; unit 262.50
    r = req(
        assemblies=[{"code": "circuit_20a", "qty": 3}],
        company_rates=rates(target_margin_pct=D("0")),
    )
    line = price(r, CATALOG).lines[0]
    assert line.total == D("787.50")
    assert line.unit_price == D("262.50")


def test_unknown_assembly() -> None:
    with pytest.raises(UnknownAssemblyError):
        price(req(assemblies=[{"code": "nope"}]), CATALOG)


def test_unknown_modifier() -> None:
    r = req(assemblies=[{"code": "circuit_20a", "modifiers": ["nope"]}])
    with pytest.raises(UnknownModifierError):
        price(r, CATALOG)


def test_modifier_not_allowed() -> None:
    r = req(assemblies=[{"code": "panel_200a", "modifiers": ["attic_run"]}])
    with pytest.raises(ModifierNotAllowedError):
        price(r, CATALOG)


def test_unknown_sku() -> None:
    with pytest.raises(UnknownSkuError):
        price(req(assemblies=[{"code": "bad_bom"}]), CATALOG)


def test_determinism_same_input_identical_output() -> None:
    r = req(
        assemblies=[
            {"code": "circuit_20a", "qty": 2, "modifiers": ["stucco_exterior", "attic_run"]},
            {"code": "recessed_led", "selected_tier": "better"},
        ],
        allowances=[{"description": "Permit", "amount": "150"}],
        company_rates=rates(tax_rate_pct=D("8.25"), helper_rate=D("75")),
        region="west",
        adjustments={"discount": "50"},
    )
    first = price(r, CATALOG)
    second = price(r, CATALOG)
    assert first.model_dump_json() == second.model_dump_json()


def test_company_rates_defaults() -> None:
    minimal = CompanyRates(labor_rate=D("100"))
    assert minimal.markup_model == "margin"
    assert minimal.job_minimum == D("0")


def test_engine_version_stamped() -> None:
    assert price(req(), CATALOG).engine_version == "2.0.0"


def test_verify_line_type_reserved() -> None:
    # verify lines are created by the AI layer (Phase 3) as zero-priced rows;
    # the engine's Adjustments model must reject negative discounts outright.
    with pytest.raises(ValueError):
        Adjustments(discount=D("-5"))
    with pytest.raises(ValueError):
        AllowanceLine(description="x", amount=D("-1"))
    with pytest.raises(ValueError):
        RequestLine(code="circuit_20a", qty=D("0"))
