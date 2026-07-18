"""Golden-file suite: every scenario's full output is pinned byte-for-byte.

If an intentional engine change breaks these, regenerate with
`uv run python tests/pricing/generate_goldens.py` and commit the diff in a
dedicated snapshot-update commit with rationale (ADR-0005).
"""

import json
from pathlib import Path

import pytest

from fieldquote.pricing import PricingRequest, price
from tests.pricing.catalog_fixture import make_catalog
from tests.pricing.scenarios import SCENARIOS

GOLDEN_DIR = Path(__file__).parent / "golden"
CATALOG = make_catalog()


def test_every_scenario_has_a_golden_file() -> None:
    files = {path.stem for path in GOLDEN_DIR.glob("*.json")}
    assert files == set(SCENARIOS), (
        "Golden files out of sync with scenarios.py — run generate_goldens.py"
    )


def test_scenario_count_meets_phase2_bar() -> None:
    assert len(SCENARIOS) >= 40


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_golden(name: str) -> None:
    golden = json.loads((GOLDEN_DIR / f"{name}.json").read_text(encoding="utf-8"))
    request = PricingRequest.model_validate(golden["input"])
    result = json.loads(price(request, CATALOG).model_dump_json())
    assert result == golden["expected"], (
        f"Engine output changed for '{name}'. If intentional, regenerate goldens "
        "and commit the snapshot update with rationale."
    )
