# Phase 3 Gate Report — AI Pipeline: ASR → Vision → Scoping → Orchestrator

**Date:** 2026-07-18 · **Branch:** `phase/3-ai-pipeline` · **Sessions:** 1

## 1. Deliverables

| #   | Deliverable                                                                                                 | Status                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Interfaces: `ASRProvider` (Deepgram + Whisper-fallback), `VisionAnalyzer`, `ScopingModel`, each with a Fake | ✅ Protocols in `ai/*/base.py`; fakes stream prose word-by-word to exercise the progressive UX offline                                                                                                                                                                                                      |
| 2   | ASR worker with electrical vocabulary boost                                                                 | ✅ Deepgram nova-3 keyterms (AFCI, GFCI, Zinsco, FPE, meter main, EMT, NM-B, megger, ampacity…); transcript persisted on `captures`                                                                                                                                                                         |
| 3   | Vision pass (Claude): only-what-is-visible structured findings                                              | ✅ `VisionFindings` schema (panel/hazards/equipment/environment/ocr/confidence), nulls never guessed, one JSON-repair retry; failures degrade to a flagged capture, not a failed run                                                                                                                        |
| 4   | Scoping model, versioned prompt, structured output                                                          | ✅ `prompts/scoping_v1.md` committed; streaming SSE with live `scope_prose` extraction; schema `extra="forbid"` — **structurally price-free**                                                                                                                                                               |
| 5   | Validation + repair loop                                                                                    | ✅ Catalog validator returns exact error strings → one repair retry → `generation_failed` with user-safe reason (raw model errors never surface; tested)                                                                                                                                                    |
| 6   | Generation orchestrator (arq)                                                                               | ✅ `run_generation`: captures → ASR (fallback chain) → vision → scoping → **pricing engine** → draft estimate v(n) with standard/allowance/verify lines; Realtime events `generation.started` / `scope.partial` / `estimate.ready` / `generation.failed`; arq task with max_tries=3 + dead-letter recording |
| 7   | Fixture library ≥ 12 + contract tests                                                                       | ✅ 12 fixtures (panel swap, EV long run, breaker trip, remodel rough-in, hot tub, fan install, ambiguous rambling, Spanish snippet, wrong trade, empty audio, photo-only, voice-only); 18 contract tests incl. evidence-grounding and no-dollar-amounts checks                                              |
| 8   | Eval harness                                                                                                | ✅ `evals/run_scoping_eval.py` — live precision/recall scorecard per prompt version (manual trigger; not yet run — no key in this environment, HUMAN_TODO already covers key setup)                                                                                                                         |
| 9   | Cost/latency instrumentation                                                                                | ✅ provider-call + generation events → structured logs always, PostHog when key present                                                                                                                                                                                                                     |

Also shipped: captures API (signed-upload create → complete → list), estimates read API + `POST /jobs/{id}/estimates/generate` (202, queued; refuses jobs with no synced captures), `EventBus` (Supabase Realtime broadcast impl + fakes), `Queue` interface (arq impl + fake).

## 2. Verification output

```
uv run ruff …                        → All checks passed
uv run mypy                          → Success: no issues found in 55 source files
uv run pytest -q                     → 139 passed, 4 skipped
pytest -m "rls or db" (Postgres 15)  → 29 passed
pricing coverage gate                → 100.00% (unchanged)
```

Key integration proof (`test_generation_db.py`): full pipeline with fakes against live
Postgres — draft-only estimates (§0.1.2), engine-priced lines (6.00h/$100.00 hand-checked),
$0 allowances (LLM never prices), verify lines from flags, version increments, user-safe
failure rows, outside-scope graceful path, event ordering started→partial→ready.

## 3. Test summary

139 unit (83 pricing + 17 AI pipeline + 18 fixture contracts + rest) · 29 live-DB
(8 RLS + catalog/preview + 6 generation) · turbo 12/12 (unchanged JS surface except
regenerated OpenAPI client).

## 4. HUMAN_TODO

No new entries. Existing items unlock live behavior: ANTHROPIC_API_KEY + DEEPGRAM_API_KEY
are already provided per status report — first live eval run is a Phase 4/5 session task
(`uv run python evals/run_scoping_eval.py`).

## 5. Known debt

| ID      | Item                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------- |
| FQ-D012 | Vision/scoping token counts not yet parsed from API responses (latency + counts logged; $ estimate pending)               |
| FQ-D013 | `SupabaseRealtimeBus` uses the REST broadcast endpoint; mobile subscription E2E untested until Phase 4 wiring             |
| FQ-D014 | Whisper fallback requires WHISPER_CMD (external CLI); no bundled model. Deepgram-down scenario degrades to friendly retry |
| FQ-D015 | Live eval scorecard not yet generated (needs a keyed environment run)                                                     |

## 6. GO / NO-GO

**GO for Phase 4.** The capture→estimate server path is complete and contract-tested
offline; mobile capture (Phase 4) plugs into existing endpoints (`POST /jobs/{id}/captures`,
`/complete`, `/estimates/generate`) and the realtime events are already emitted.
