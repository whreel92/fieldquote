"""Validate the placeholder electrical seed catalog.

Stdlib-only. Checks referential integrity and schema basics across all
catalog JSON files. Exits 0 on success, 1 with all errors listed.

Usage (from apps/api):
    uv run python seeds/catalog/validate_catalog.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

CATALOG_DIR = Path(__file__).resolve().parent

ASSEMBLY_FILES = [
    "assemblies_panel_service.json",
    "assemblies_ev_charger.json",
    "assemblies_circuits_receptacles.json",
    "assemblies_fixtures_fans.json",
    "assemblies_remodel.json",
    "assemblies_generator.json",
    "assemblies_special_circuits.json",
    "assemblies_service_diagnostic.json",
    "assemblies_repairs.json",
]

VALID_JOB_TYPES = {
    "panel_upgrade", "ev_charger", "service_call", "circuits_outlets",
    "fixtures_fans", "remodel", "generator", "other",
}
VALID_UNITS = {"ea", "ft", "opening"}
VALID_MATERIAL_UNITS = {"ea", "ft", "box", "roll"}
VALID_TIERS = {"good", "better", "best"}
TOTAL_MIN, TOTAL_MAX = 145, 160


def load(name: str, errors: list[str]):
    path = CATALOG_DIR / name
    if not path.exists():
        errors.append(f"{name}: file missing")
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as exc:
        errors.append(f"{name}: invalid JSON ({exc})")
        return None
    if not isinstance(data, list):
        errors.append(f"{name}: top-level value must be an array")
        return None
    return data


def check_bom(bom, skus: set[str], where: str, errors: list[str]) -> None:
    if not isinstance(bom, list):
        errors.append(f"{where}: bom must be an array")
        return
    for i, item in enumerate(bom):
        if not isinstance(item, dict) or "sku" not in item or "qty" not in item:
            errors.append(f"{where}: bom[{i}] must be an object with sku and qty")
            continue
        if item["sku"] not in skus:
            errors.append(f"{where}: bom sku {item['sku']!r} not found in materials.json")
        if (
            not isinstance(item["qty"], (int, float))
            or isinstance(item["qty"], bool)
            or item["qty"] <= 0
        ):
            errors.append(f"{where}: bom[{i}] qty must be a positive number")


def main() -> int:
    errors: list[str] = []

    # ---- materials -------------------------------------------------------
    materials = load("materials.json", errors) or []
    skus: set[str] = set()
    for i, m in enumerate(materials):
        where = f"materials.json[{i}]"
        sku = m.get("sku")
        if not sku or not isinstance(sku, str):
            errors.append(f"{where}: missing/invalid sku")
            continue
        if sku in skus:
            errors.append(f"{where}: duplicate sku {sku!r}")
        skus.add(sku)
        if m.get("unit") not in VALID_MATERIAL_UNITS:
            errors.append(f"{where} ({sku}): unit must be one of {sorted(VALID_MATERIAL_UNITS)}")
        price = m.get("base_price")
        if not isinstance(price, (int, float)) or isinstance(price, bool) or price <= 0:
            errors.append(f"{where} ({sku}): base_price must be a positive number")

    # ---- modifiers -------------------------------------------------------
    modifiers = load("modifiers.json", errors) or []
    mod_codes: set[str] = set()
    for i, mod in enumerate(modifiers):
        code = mod.get("code")
        where = f"modifiers.json[{i}]"
        if not code or not isinstance(code, str):
            errors.append(f"{where}: missing/invalid code")
            continue
        if code in mod_codes:
            errors.append(f"{where}: duplicate modifier code {code!r}")
        mod_codes.add(code)
        effect = mod.get("effect")
        if not isinstance(effect, dict) or not effect:
            errors.append(f"{where} ({code}): effect must be a non-empty object")
        else:
            allowed_keys = {"labor_hours_mult", "labor_hours_add", "material_mult"}
            for k in effect:
                if k not in allowed_keys:
                    errors.append(f"{where} ({code}): unknown effect key {k!r}")

    # ---- assemblies ------------------------------------------------------
    asm_codes: set[str] = set()
    counts: dict[str, int] = {}
    total = 0
    for fname in ASSEMBLY_FILES:
        data = load(fname, errors)
        if data is None:
            counts[fname] = 0
            continue
        counts[fname] = len(data)
        total += len(data)
        for i, a in enumerate(data):
            code = a.get("code")
            where = f"{fname}[{i}]" + (f" ({code})" if code else "")
            if not code or not isinstance(code, str):
                errors.append(f"{where}: missing/invalid code")
                continue
            if code in asm_codes:
                errors.append(
                    f"{where}: duplicate assembly code {code!r} (must be unique across all files)"
                )
            asm_codes.add(code)

            jts = a.get("job_type_codes")
            if not isinstance(jts, list) or not jts:
                errors.append(f"{where}: job_type_codes must be a non-empty array")
            else:
                for jt in jts:
                    if jt not in VALID_JOB_TYPES:
                        errors.append(f"{where}: invalid job_type_code {jt!r}")

            if a.get("unit") not in VALID_UNITS:
                errors.append(f"{where}: unit must be one of {sorted(VALID_UNITS)}")

            lh = a.get("labor_hours")
            if not isinstance(lh, (int, float)) or isinstance(lh, bool) or lh <= 0:
                errors.append(f"{where}: labor_hours must be > 0")
            hh = a.get("helper_hours")
            if not isinstance(hh, (int, float)) or isinstance(hh, bool) or hh < 0:
                errors.append(f"{where}: helper_hours must be a number >= 0")

            if not a.get("labor_notes") or not isinstance(a.get("labor_notes"), str):
                errors.append(f"{where}: labor_notes is required (advisor review rationale)")

            check_bom(a.get("bom", []), skus, where, errors)

            mods = a.get("modifiers_allowed")
            if not isinstance(mods, list):
                errors.append(f"{where}: modifiers_allowed must be an array")
            else:
                for mc in mods:
                    if mc not in mod_codes:
                        errors.append(
                            f"{where}: modifiers_allowed code {mc!r} not in modifiers.json"
                        )

            tiers = a.get("option_tiers")
            if tiers is not None:
                if not isinstance(tiers, list) or not tiers:
                    errors.append(f"{where}: option_tiers must be null or a non-empty array")
                else:
                    tier_names = []
                    for j, t in enumerate(tiers):
                        tname = t.get("tier")
                        tier_names.append(tname)
                        twhere = f"{where}.option_tiers[{j}]"
                        if tname not in VALID_TIERS:
                            errors.append(f"{twhere}: tier must be one of {sorted(VALID_TIERS)}")
                        tlh = t.get("labor_hours")
                        if not isinstance(tlh, (int, float)) or isinstance(tlh, bool) or tlh <= 0:
                            errors.append(f"{twhere}: labor_hours must be > 0")
                        thh = t.get("helper_hours")
                        if not isinstance(thh, (int, float)) or isinstance(thh, bool) or thh < 0:
                            errors.append(f"{twhere}: helper_hours must be a number >= 0")
                        if not t.get("label"):
                            errors.append(f"{twhere}: label is required")
                        check_bom(t.get("bom", []), skus, twhere, errors)
                    if "good" not in tier_names:
                        errors.append(f"{where}: option_tiers must include a 'good' tier")
                    if len(tier_names) != len(set(tier_names)):
                        errors.append(f"{where}: option_tiers contains duplicate tier names")

    if not (TOTAL_MIN <= total <= TOTAL_MAX):
        errors.append(
            f"total assembly count {total} outside required range {TOTAL_MIN}-{TOTAL_MAX}"
        )

    # ---- summary ---------------------------------------------------------
    print("Catalog summary")
    print(f"  materials.json: {len(materials)} SKUs")
    print(f"  modifiers.json: {len(modifiers)} modifiers")
    for fname in ASSEMBLY_FILES:
        print(f"  {fname}: {counts.get(fname, 0)} assemblies")
    print(f"  TOTAL assemblies: {total}")

    if errors:
        print(f"\nFAILED: {len(errors)} error(s)")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("\nOK: catalog is internally consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
