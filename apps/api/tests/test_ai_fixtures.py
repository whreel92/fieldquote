"""Contract tests over the recorded AI fixture library (no live API calls).

Every fixture's expected scoping output must: validate against the schema,
reference only real seed-catalog codes/modifiers/tiers, justify every
assembly with evidence grounded in the inputs, degrade missing information
into allowances/verify_flags, and contain no dollar amounts anywhere."""

import json
import re
from pathlib import Path

import pytest

from fieldquote.ai.types import CaptureInput, ScopingOutput
from fieldquote.services.catalog import load_catalog_from_seed_files
from fieldquote.services.generation import JOB_TYPE_CODES
from fieldquote.services.scoping_validation import validate_scoping

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "ai"
CATALOG = load_catalog_from_seed_files()

EXPECTED_NAMES = {
    "panel_swap",
    "ev_charger_long_run",
    "service_call_breaker_trip",
    "remodel_rough_in",
    "hot_tub",
    "fan_install",
    "ambiguous_rambling",
    "non_english_snippet",
    "wrong_trade",
    "empty_audio",
    "photo_only",
    "voice_only",
}

_WORD = re.compile(r"[a-záéíóúñ0-9]{4,}", re.IGNORECASE)
_DOLLAR = re.compile(r"\$\s?\d")


def _load(name: str) -> dict[str, object]:
    with open(FIXTURE_DIR / f"{name}.json", encoding="utf-8") as fh:
        data: dict[str, object] = json.load(fh)
    return data


def test_fixture_library_complete() -> None:
    found = {path.stem for path in FIXTURE_DIR.glob("*.json")}
    assert found >= EXPECTED_NAMES, f"missing fixtures: {EXPECTED_NAMES - found}"
    assert len(found) >= 12


@pytest.mark.parametrize("name", sorted(EXPECTED_NAMES))
def test_fixture_contract(name: str) -> None:
    fixture = _load(name)
    output = ScopingOutput.model_validate(fixture["expected_scoping"])

    # 1. Catalog validity — same validator the repair loop uses.
    assert validate_scoping(output, CATALOG, JOB_TYPE_CODES) == []

    # 2. Capture inputs themselves are schema-valid.
    captures = fixture["captures"]
    assert isinstance(captures, list)
    input_text_parts: list[str] = []
    for raw in captures:
        assert isinstance(raw, dict)
        payload = {"capture_id": "cx", "kind": raw["kind"]}
        if raw["kind"] == "audio":
            payload["transcript"] = raw.get("transcript", "")
            input_text_parts.append(str(raw.get("transcript", "")))
        else:
            payload["vision_findings"] = raw["vision_findings"]
            input_text_parts.append(json.dumps(raw["vision_findings"]))
        CaptureInput.model_validate(payload)
    input_text = " ".join(input_text_parts).lower()

    # 3. Every assembly has grounded evidence: at least one significant word
    #    of the evidence appears in the inputs.
    for scoped in output.assemblies:
        assert scoped.evidence.strip(), f"{name}: empty evidence on {scoped.code}"
        words = _WORD.findall(scoped.evidence.lower())
        assert any(word in input_text for word in words), (
            f"{name}: evidence for {scoped.code} not grounded in inputs: "
            f"{scoped.evidence!r}"
        )

    # 4. No dollar amounts anywhere in the model output (§0.1.1).
    blob = json.dumps(fixture["expected_scoping"])
    assert not _DOLLAR.search(blob), f"{name}: model output contains a dollar amount"

    # 5. Prose sanity.
    assert len(output.scope_prose) > 80 or output.outside_supported_scope
    assert "[TBD]" not in output.scope_prose


def test_wrong_trade_is_outside_scope() -> None:
    output = ScopingOutput.model_validate(_load("wrong_trade")["expected_scoping"])
    assert output.outside_supported_scope
    assert output.assemblies == []
    assert output.outside_reason


@pytest.mark.parametrize("name", ["ambiguous_rambling", "empty_audio", "photo_only"])
def test_uncertain_inputs_degrade_to_allowances_or_flags(name: str) -> None:
    output = ScopingOutput.model_validate(_load(name)["expected_scoping"])
    assert output.allowances or output.verify_flags, (
        f"{name}: uncertain input must produce allowances or verify_flags"
    )


def test_ambiguous_rambling_asks_questions() -> None:
    output = ScopingOutput.model_validate(_load("ambiguous_rambling")["expected_scoping"])
    assert len(output.questions_for_contractor) >= 2
