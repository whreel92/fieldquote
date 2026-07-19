# Phase 5 Gate Report — The Estimate Editor

**Date:** 2026-07-18 · **Branch:** `phase/5-estimate-editor` · **Sessions:** 1

## 1. Deliverables

| # | Deliverable | Status |
|---|---|---|
| 1 | Grouped line list + "show the math" detail sheet with per-field overrides, `edited` badges, audit log | ✅ API: engine reprice vs manual override paths, per-field override badges in `totals.overrides`, every mutation audited. Mobile: FlashList grouped sections + breakdown sheet |
| 2 | Add line: fuzzy assembly search, manual free-form | ✅ `/catalog/assemblies?q=` search + `POST /estimates/{id}/lines` (engine-priced or manual) |
| 3 | Confidence UI: allowance/verify distinct with AI reason; one-tap convert | ✅ badges + editable_note reasons; `POST .../convert` prices the allowance |
| 4 | Margin panel: cost basis, price, effective %, per-estimate margin adjust, floor warning | ✅ `PATCH /estimates/{id}` margin_override_pct reprices engine lines only; margin_check recomputed server-side; mobile collapsible footer |
| 5 | "What am I forgetting?" checklist mode | ✅ `checklist_v1` prompt + ClaudeChecklist/FakeChecklist; ≤5 suggestions, invalid codes filtered, tested |
| 6 | Options builder: good/better/best with editable labels/prices | ✅ `POST .../options` replaces line with tier lines; only selected tier totals; mobile builder screen |
| 7 | **Approval flow — the legal control** | ✅ section-by-section confirmations (all 4 required), owner/admin/office role, approver+timestamp stored, **red-team suite proves no code path sends/proposes a draft** |
| 8 | Versioning: approved edits fork v(n+1); prior versions read-only; diff view | ✅ fork endpoint + `fork_required` 409 on approved-estimate mutations; approval supersedes prior approved; diff endpoint + versions screen |
| 9 | Performance: FlashList, optimistic edits with rollback | ✅ (mobile) FlashList line list; optimistic qty stepper reconciled against server response |

## 2. Verification

```
uv run ruff / mypy                    → clean (58 source files)
uv run pytest -q                      → 139 passed
pytest -m "rls or db" (Postgres 15)   → 47 passed
  approval-control red team           → 8/8
  editing behavior                    → 10/10
pnpm turbo lint typecheck test        → 12/12 tasks (mobile vitest 16/16)
```

Key hand-checked engine math via the API: qty 1→3 reprice $500→$1500; modifier add
$500→$700; labor-hours override recompute $900.00; margin 50→60% reprice $625.00 with
manual lines untouched.

## 3. Usability script (acceptance: ≤ 3 min)

Create manual estimate → add assembly line via search → stepper qty ×3 → open math sheet,
override labor hours (edited badge appears) → add allowance → convert allowance to $350 →
"What am I forgetting?" → add a suggestion → Review & Approve: scope ✓ lines ✓ totals ✓
terms ✓ → Approve → Create proposal (201). Each step is one server round-trip returning the
full document; on-device walkthrough for Will listed in the physical checklist (Phase 4
report) — extend it with this script.

## 4. Known debt

| ID | Item |
|---|---|
| FQ-D019 | Margin adjust is stepper/track-based (no native slider dep); revisit with a designed slider |
| FQ-D020 | Options builder totals are manual (engine option_tiers assemblies price automatically, ad-hoc promotions don't carry BOM math) |
| FQ-D021 | Suggestions context sends transcripts but not vision findings (kept small); revisit after live eval |

## 5. GO / NO-GO

**GO for Phase 6.** The proposal entry point already exists and enforces approval;
Phase 6 builds the composer, hosted signing page, deposits, and immutable snapshots on
top of `POST /estimates/{id}/proposals`.
