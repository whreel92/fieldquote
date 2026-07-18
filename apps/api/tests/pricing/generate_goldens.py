"""Regenerate the golden pricing files.

Run only when an intentional engine change alters outputs; commit the diff in
its own snapshot-update commit with rationale (ADR-0005).

Usage: uv run python tests/pricing/generate_goldens.py
"""

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fieldquote.pricing import PricingRequest, price
from tests.pricing.catalog_fixture import make_catalog
from tests.pricing.scenarios import SCENARIOS

GOLDEN_DIR = Path(__file__).parent / "golden"


def main() -> None:
    catalog = make_catalog()
    GOLDEN_DIR.mkdir(exist_ok=True)
    for name, payload in SCENARIOS.items():
        request = PricingRequest.model_validate(payload)
        result = price(request, catalog)
        golden: dict[str, Any] = {
            "scenario": name,
            "input": payload,
            "expected": json.loads(result.model_dump_json()),
        }
        path = GOLDEN_DIR / f"{name}.json"
        path.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Wrote {len(SCENARIOS)} golden files to {GOLDEN_DIR}")


if __name__ == "__main__":
    main()
