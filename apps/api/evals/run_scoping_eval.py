"""Live scoping eval harness (manual trigger — NEVER runs in CI).

Replays the recorded fixture inputs against the LIVE scoping model and scores
assembly selection against each fixture's expected output:

  precision  — selected assemblies that are in the expected set
  recall     — expected assemblies that were selected
  validity   — output passed schema + catalog validation (after repair loop)

Writes a markdown scorecard to evals/scorecards/. This is the tool for prompt
iteration: change prompts/scoping_vN.md, rerun, diff scorecards.

Usage: cd apps/api && uv run python evals/run_scoping_eval.py [fixture ...]
Requires ANTHROPIC_API_KEY.
"""

import json
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(API_DIR / "src"))

from fieldquote.ai.scoping.claude import PROMPT_VERSION, ClaudeScoping  # noqa: E402
from fieldquote.ai.types import CaptureInput, ScopingContext, ScopingOutput  # noqa: E402
from fieldquote.core.config import get_settings  # noqa: E402
from fieldquote.services.catalog import load_catalog_from_seed_files  # noqa: E402
from fieldquote.services.generation import JOB_TYPE_CODES  # noqa: E402
from fieldquote.services.scoping_validation import validate_scoping  # noqa: E402

FIXTURE_DIR = API_DIR / "tests" / "fixtures" / "ai"
SCORECARD_DIR = Path(__file__).parent / "scorecards"


def build_context(fixture: dict[str, object], catalog_summary: list[object]) -> ScopingContext:
    job = fixture["job"]
    assert isinstance(job, dict)
    captures = []
    raw_captures = fixture["captures"]
    assert isinstance(raw_captures, list)
    for index, raw in enumerate(raw_captures):
        payload: dict[str, object] = {"capture_id": f"c{index}", "kind": raw["kind"]}
        if raw["kind"] == "audio":
            payload["transcript"] = raw.get("transcript", "")
        else:
            payload["vision_findings"] = raw["vision_findings"]
        captures.append(CaptureInput.model_validate(payload))
    catalog = load_catalog_from_seed_files()
    return ScopingContext(
        job_title=str(job.get("title", "")),
        job_type_code=job.get("job_type_code"),  # type: ignore[arg-type]
        job_address=job.get("address"),  # type: ignore[arg-type]
        captures=captures,
        catalog=catalog_summary,  # type: ignore[arg-type]
        modifier_codes=sorted(catalog.modifiers),
        job_type_codes=JOB_TYPE_CODES,
    )


def main() -> None:
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise SystemExit("ANTHROPIC_API_KEY not set — see docs/HUMAN_TODO.md")

    catalog = load_catalog_from_seed_files()
    from fieldquote.ai.types import CatalogSummaryEntry

    summary = [
        CatalogSummaryEntry(
            code=a.code,
            name=a.name,
            unit=a.unit,
            job_type_codes=list(a.job_type_codes),
            modifiers_allowed=list(a.modifiers_allowed),
            has_option_tiers=bool(a.option_tiers),
        )
        for a in sorted(catalog.assemblies.values(), key=lambda a: a.code)
    ]

    wanted = sys.argv[1:]
    fixtures = sorted(FIXTURE_DIR.glob("*.json"))
    if wanted:
        fixtures = [f for f in fixtures if f.stem in wanted]

    model = ClaudeScoping(settings.anthropic_api_key)
    rows: list[str] = []
    totals = {"tp": 0, "fp": 0, "fn": 0, "valid": 0, "count": 0}

    for path in fixtures:
        with open(path, encoding="utf-8") as fh:
            fixture = json.load(fh)
        expected = ScopingOutput.model_validate(fixture["expected_scoping"])
        expected_codes = {a.code for a in expected.assemblies}
        context = build_context(fixture, summary)

        started = time.monotonic()
        try:
            actual = model.scope(context)
            errors = validate_scoping(actual, catalog, JOB_TYPE_CODES)
            if errors:
                actual = model.scope(context, repair_hint="\n".join(errors))
                errors = validate_scoping(actual, catalog, JOB_TYPE_CODES)
            valid = not errors
            actual_codes = {a.code for a in actual.assemblies}
        except Exception as exc:
            rows.append(f"| {path.stem} | ERROR | — | — | — | {exc} |")
            totals["count"] += 1
            continue
        elapsed = time.monotonic() - started

        tp = len(actual_codes & expected_codes)
        fp = len(actual_codes - expected_codes)
        fn = len(expected_codes - actual_codes)
        totals["tp"] += tp
        totals["fp"] += fp
        totals["fn"] += fn
        totals["valid"] += int(valid)
        totals["count"] += 1
        precision = tp / (tp + fp) if tp + fp else 1.0
        recall = tp / (tp + fn) if tp + fn else 1.0
        outside_ok = actual.outside_supported_scope == expected.outside_supported_scope
        rows.append(
            f"| {path.stem} | {'ok' if valid else 'INVALID'} | {precision:.2f} | "
            f"{recall:.2f} | {elapsed:.1f}s | outside_scope "
            f"{'match' if outside_ok else 'MISMATCH'} |"
        )

    precision = totals["tp"] / (totals["tp"] + totals["fp"]) if totals["tp"] + totals["fp"] else 1.0
    recall = totals["tp"] / (totals["tp"] + totals["fn"]) if totals["tp"] + totals["fn"] else 1.0
    stamp = datetime.now(tz=UTC).strftime("%Y%m%d-%H%M%S")
    SCORECARD_DIR.mkdir(exist_ok=True)
    out = SCORECARD_DIR / f"scoping-{PROMPT_VERSION}-{stamp}.md"
    out.write_text(
        "\n".join(
            [
                f"# Scoping eval — {PROMPT_VERSION} — {stamp}",
                "",
                f"Fixtures: {totals['count']} · valid: {totals['valid']}/{totals['count']} · "
                f"assembly precision: {precision:.2f} · recall: {recall:.2f}",
                "",
                "| fixture | validity | precision | recall | latency | notes |",
                "|---|---|---|---|---|---|",
                *rows,
                "",
            ]
        ),
        encoding="utf-8",
    )
    print(f"Scorecard: {out}")


if __name__ == "__main__":
    main()
