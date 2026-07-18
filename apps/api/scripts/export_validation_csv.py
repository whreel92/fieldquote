"""Export the assembly catalog as the advisor review packet CSV.

Reads seeds/catalog/*.json directly (no DB needed) and writes
docs/validation/assemblies_v0.csv with one row per assembly (and one row per
option tier) — the exact packet described in docs/ASSEMBLY_VALIDATION.md.

Usage: uv run python scripts/export_validation_csv.py
"""

import csv
import json
from pathlib import Path
from typing import Any

API_DIR = Path(__file__).resolve().parents[1]
CATALOG_DIR = API_DIR / "seeds" / "catalog"
OUT_PATH = API_DIR.parents[1] / "docs" / "validation" / "assemblies_v0.csv"

COLUMNS = [
    "assembly_code",
    "tier",
    "name",
    "job_types",
    "unit",
    "labor_hours",
    "helper_hours",
    "labor_notes",
    "bom (sku x qty)",
    "modifiers_allowed",
    "advisor_verdict (approve / adjust)",
    "adjusted_labor_hours",
    "advisor_notes",
]


def _bom_text(bom: list[dict[str, Any]], materials: dict[str, str]) -> str:
    return "; ".join(
        f"{item['sku']} ({materials.get(item['sku'], '?')}) x {item['qty']}" for item in bom
    )


def main() -> None:
    with open(CATALOG_DIR / "materials.json", encoding="utf-8") as fh:
        materials = {m["sku"]: m["description"] for m in json.load(fh)}

    rows: list[dict[str, str]] = []
    for path in sorted(CATALOG_DIR.glob("assemblies_*.json")):
        with open(path, encoding="utf-8") as fh:
            for assembly in json.load(fh):
                base = {
                    "assembly_code": assembly["code"],
                    "tier": "",
                    "name": assembly["name"],
                    "job_types": ", ".join(assembly["job_type_codes"]),
                    "unit": assembly.get("unit", "ea"),
                    "labor_hours": str(assembly["labor_hours"]),
                    "helper_hours": str(assembly.get("helper_hours", 0)),
                    "labor_notes": assembly.get("labor_notes", ""),
                    "bom (sku x qty)": _bom_text(assembly.get("bom", []), materials),
                    "modifiers_allowed": ", ".join(assembly.get("modifiers_allowed", [])),
                    "advisor_verdict (approve / adjust)": "",
                    "adjusted_labor_hours": "",
                    "advisor_notes": "",
                }
                rows.append(base)
                for tier in assembly.get("option_tiers") or []:
                    rows.append(
                        base
                        | {
                            "tier": f"{tier['tier']} — {tier['label']}",
                            "labor_hours": str(tier["labor_hours"]),
                            "helper_hours": str(tier.get("helper_hours", 0)),
                            "bom (sku x qty)": _bom_text(tier.get("bom", []), materials),
                        }
                    )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"Wrote {len(rows)} rows to {OUT_PATH}")


if __name__ == "__main__":
    main()
