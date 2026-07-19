"""No-DB unit tests for the AI pipeline: scoping validation, the repair loop,
prose streaming, and provider fallback behavior."""

from decimal import Decimal

import pytest

from fieldquote.ai.asr.base import ASRError
from fieldquote.ai.asr.fake import FakeASR
from fieldquote.ai.asr.whisper_fallback import WhisperFallbackASR
from fieldquote.ai.scoping.claude import _ProseStreamer, build_user_message
from fieldquote.ai.scoping.fake import FakeScoping
from fieldquote.ai.types import (
    CaptureInput,
    GenerationFailure,
    ScopingContext,
    ScopingOutput,
    VisionFindings,
)
from fieldquote.ai.vision.fake import FakeVision
from fieldquote.services.events import FakeEventBus
from fieldquote.services.generation import JOB_TYPE_CODES, Providers, _scope_with_repair
from fieldquote.services.scoping_validation import validate_scoping
from tests.pricing.catalog_fixture import make_catalog

CATALOG = make_catalog()


def output(**overrides: object) -> ScopingOutput:
    payload: dict[str, object] = {
        "job_type_code": "circuits_outlets",
        "assemblies": [
            {"code": "circuit_20a", "qty": 1, "modifiers": ["attic_run"], "evidence": "said attic"}
        ],
        "scope_prose": "We will add a dedicated 20A circuit routed through the attic.",
    }
    payload.update(overrides)
    return ScopingOutput.model_validate(payload)


def context() -> ScopingContext:
    return ScopingContext(
        job_title="Test job",
        job_type_code="circuits_outlets",
        captures=[CaptureInput(capture_id="c1", kind="audio", transcript="add a circuit")],
        catalog=[],
        modifier_codes=sorted(CATALOG.modifiers),
        job_type_codes=JOB_TYPE_CODES,
    )


# ── validation ───────────────────────────────────────────────────────────────


def test_valid_output_passes() -> None:
    assert validate_scoping(output(), CATALOG, JOB_TYPE_CODES) == []


def test_unknown_assembly_code_flagged() -> None:
    bad = output(assemblies=[{"code": "made_up", "qty": 1, "evidence": "x"}])
    errors = validate_scoping(bad, CATALOG, JOB_TYPE_CODES)
    assert len(errors) == 1 and "made_up" in errors[0]


def test_disallowed_modifier_flagged() -> None:
    bad = output(
        assemblies=[
            {"code": "panel_200a", "qty": 1, "modifiers": ["attic_run"], "evidence": "x"}
        ]
    )
    errors = validate_scoping(bad, CATALOG, JOB_TYPE_CODES)
    assert "not allowed" in errors[0]


def test_bad_job_type_flagged() -> None:
    errors = validate_scoping(output(job_type_code="hvac"), CATALOG, JOB_TYPE_CODES)
    assert "job_type_code" in errors[0]


def test_tier_on_non_tiered_assembly_flagged() -> None:
    bad = output(
        assemblies=[{"code": "circuit_20a", "qty": 1, "selected_tier": "best", "evidence": "x"}]
    )
    errors = validate_scoping(bad, CATALOG, JOB_TYPE_CODES)
    assert "no option tiers" in errors[0]


def test_missing_tier_flagged() -> None:
    bad = output(
        assemblies=[
            {"code": "two_tier_only", "qty": 1, "selected_tier": "best", "evidence": "x"}
        ]
    )
    errors = validate_scoping(bad, CATALOG, JOB_TYPE_CODES)
    assert "not available" in errors[0]


def test_outside_scope_must_have_no_assemblies() -> None:
    bad = output(outside_supported_scope=True, outside_reason="not our trade")
    errors = validate_scoping(bad, CATALOG, JOB_TYPE_CODES)
    assert "outside_supported_scope" in errors[0]

    good = output(
        outside_supported_scope=True, outside_reason="not our trade", assemblies=[]
    )
    assert validate_scoping(good, CATALOG, JOB_TYPE_CODES) == []


def test_no_price_fields_exist_in_schema() -> None:
    # §0.1.1 structurally: the model's schema has nowhere to put a price.
    with pytest.raises(ValueError):
        ScopingOutput.model_validate(
            {
                "job_type_code": "other",
                "scope_prose": "x",
                "price": 100,
            }
        )


# ── repair loop ──────────────────────────────────────────────────────────────


def test_repair_loop_retries_once_with_errors_and_succeeds() -> None:
    bad = output(assemblies=[{"code": "nope", "qty": 1, "evidence": "x"}])
    fake = FakeScoping(bad, repaired_output=output())
    providers = Providers(asr=FakeASR(), asr_fallback=None, vision=FakeVision(), scoping=fake)
    bus = FakeEventBus()
    result = _scope_with_repair(providers, context(), CATALOG, bus, "job:test")
    assert result.assemblies[0].code == "circuit_20a"
    assert fake.calls == 2
    assert "nope" in fake.repair_hints[0]


def test_repair_loop_fails_after_second_invalid_output() -> None:
    bad = output(assemblies=[{"code": "nope", "qty": 1, "evidence": "x"}])
    fake = FakeScoping(bad, repaired_output=bad)
    providers = Providers(asr=FakeASR(), asr_fallback=None, vision=FakeVision(), scoping=fake)
    with pytest.raises(GenerationFailure) as excinfo:
        _scope_with_repair(providers, context(), CATALOG, FakeEventBus(), "job:test")
    # user-safe message, raw model errors stay internal
    assert "nope" not in excinfo.value.user_message
    assert "nope" in excinfo.value.internal


def test_prose_streams_to_event_bus() -> None:
    fake = FakeScoping(output())
    providers = Providers(asr=FakeASR(), asr_fallback=None, vision=FakeVision(), scoping=fake)
    bus = FakeEventBus()
    _scope_with_repair(providers, context(), CATALOG, bus, "job:test")
    partials = [p for _, event, p in bus.events if event == "scope.partial"]
    assert partials
    text = "".join(p["text"] for p in partials)
    assert "dedicated 20A circuit" in text


# ── prose streamer (claude streaming JSON) ───────────────────────────────────


def test_prose_streamer_extracts_string_across_chunks() -> None:
    got: list[str] = []
    streamer = _ProseStreamer(got.append)
    for chunk in [
        '{"job_type_code": "other", "scope',
        '_prose": "Hello ',
        'world\\nsecond line", "assemblies": []}',
    ]:
        streamer.feed(chunk)
    assert "".join(got) == "Hello world\nsecond line"


def test_prose_streamer_handles_no_callback() -> None:
    streamer = _ProseStreamer(None)
    streamer.feed('{"scope_prose": "x"}')  # must not raise


# ── ASR fallback ─────────────────────────────────────────────────────────────


def test_whisper_unconfigured_raises_asr_error() -> None:
    with pytest.raises(ASRError):
        WhisperFallbackASR(command_template="").transcribe(b"xx", "audio/m4a")


def test_fake_asr_roundtrip() -> None:
    result = FakeASR("panel swap").transcribe(b"ignored", "audio/m4a")
    assert result.text == "panel swap"


# ── user message rendering ───────────────────────────────────────────────────


def test_build_user_message_includes_catalog_and_transcript() -> None:
    ctx = ScopingContext(
        job_title="Panel job",
        job_type_code="panel_upgrade",
        captures=[
            CaptureInput(capture_id="a1", kind="audio", transcript="swap the panel"),
            CaptureInput(
                capture_id="p1",
                kind="photo",
                vision_findings=VisionFindings.model_validate(
                    {"panel": {"brand": "Zinsco", "amperage": 100}, "provider": "fake"}
                ),
            ),
        ],
        catalog=[
            {
                "code": "panel_x",
                "name": "Panel X",
                "unit": "ea",
                "job_type_codes": ["panel_upgrade"],
                "modifiers_allowed": ["occupied_home"],
                "has_option_tiers": False,
            }
        ],
        modifier_codes=["occupied_home"],
        job_type_codes=JOB_TYPE_CODES,
    )
    message = build_user_message(ctx)
    assert "swap the panel" in message
    assert "Zinsco" in message
    assert "panel_x | Panel X" in message
    assert "occupied_home" in message


def test_scoped_assembly_qty_must_be_positive() -> None:
    with pytest.raises(ValueError):
        ScopingOutput.model_validate(
            {
                "job_type_code": "other",
                "assemblies": [{"code": "x", "qty": Decimal("0"), "evidence": "e"}],
                "scope_prose": "p",
            }
        )
