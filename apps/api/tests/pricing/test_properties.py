"""Property tests (hypothesis): determinism, no negative money, invariants."""

from decimal import Decimal

from hypothesis import given, settings
from hypothesis import strategies as st

from fieldquote.pricing import CompanyRates, PricingRequest, price
from tests.pricing.catalog_fixture import make_catalog

D = Decimal
CATALOG = make_catalog()

money = st.decimals(min_value=0, max_value=10_000, places=2)
qty = st.decimals(min_value=D("0.5"), max_value=20, places=1)
pct = st.decimals(min_value=0, max_value=95, places=1)

modifier_sets = st.lists(
    st.sampled_from(["stucco_exterior", "attic_run", "long_run"]),
    max_size=3,
    unique=True,
)

line = st.fixed_dictionaries(
    {"code": st.just("circuit_20a"), "qty": qty, "modifiers": modifier_sets}
)
tier_line = st.fixed_dictionaries(
    {
        "code": st.just("recessed_led"),
        "qty": qty,
        "selected_tier": st.sampled_from(["good", "better", "best"]),
    }
)
plain_line = st.fixed_dictionaries({"code": st.just("panel_200a"), "qty": qty})

request_strategy = st.builds(
    lambda lines, allowance_amt, rates_kw, region, discount: PricingRequest.model_validate(
        {
            "assemblies": lines,
            "allowances": (
                [{"description": "Allowance", "amount": allowance_amt}] if allowance_amt else []
            ),
            "company_rates": rates_kw,
            "region": region,
            "adjustments": {"discount": discount},
        }
    ),
    lines=st.lists(st.one_of(line, tier_line, plain_line), max_size=5),
    allowance_amt=st.one_of(st.none(), money),
    rates_kw=st.fixed_dictionaries(
        {
            "labor_rate": st.decimals(min_value=50, max_value=400, places=2),
            "helper_rate": st.one_of(
                st.none(), st.decimals(min_value=20, max_value=200, places=2)
            ),
            "target_margin_pct": pct,
            "tax_rate_pct": st.decimals(min_value=0, max_value=12, places=2),
            "markup_model": st.sampled_from(["margin", "markup"]),
            "job_minimum": st.one_of(st.just(D("0")), money),
        }
    ),
    region=st.sampled_from(["default", "west", "unknown_region"]),
    discount=money,
)


@settings(max_examples=200, deadline=None)
@given(request_strategy)
def test_no_negative_totals_and_internal_consistency(request: PricingRequest) -> None:
    result = price(request, CATALOG)
    assert result.subtotal >= 0
    assert result.tax >= 0
    assert result.total >= 0
    assert result.total == result.subtotal + result.tax
    included_sum = sum((ln.total for ln in result.lines if ln.included), D("0"))
    assert result.subtotal == included_sum.quantize(D("0.01"))
    for ln in result.lines:
        if ln.line_type != "discount":
            assert ln.total >= 0
        assert ln.labor_hours >= 0


@settings(max_examples=100, deadline=None)
@given(request_strategy)
def test_deterministic(request: PricingRequest) -> None:
    assert price(request, CATALOG).model_dump_json() == price(request, CATALOG).model_dump_json()


@settings(max_examples=100, deadline=None)
@given(qty, pct)
def test_price_scales_with_qty_never_decreases(quantity: Decimal, margin: Decimal) -> None:
    rates = CompanyRates(labor_rate=D("100"), target_margin_pct=margin)
    small = PricingRequest.model_validate(
        {"assemblies": [{"code": "circuit_20a", "qty": quantity}], "company_rates": rates}
    )
    bigger = PricingRequest.model_validate(
        {"assemblies": [{"code": "circuit_20a", "qty": quantity + 1}], "company_rates": rates}
    )
    assert price(bigger, CATALOG).total >= price(small, CATALOG).total


@settings(max_examples=100, deadline=None)
@given(money)
def test_job_minimum_always_respected(minimum: Decimal) -> None:
    rates = CompanyRates(labor_rate=D("100"), job_minimum=minimum)
    result = price(
        PricingRequest.model_validate(
            {"assemblies": [{"code": "recessed_led"}], "company_rates": rates}
        ),
        CATALOG,
    )
    assert result.subtotal >= minimum
