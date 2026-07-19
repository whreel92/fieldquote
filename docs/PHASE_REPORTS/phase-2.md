# Phase 2 Gate Report — Deterministic Pricing Engine + Electrical Seed Catalog

**Date:** 2026-07-18 · **Branch:** `phase/2-pricing-engine` · **Sessions:** 1

## 1. Deliverables

| #   | Deliverable                                                                                                                                                                             | Status                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fieldquote/pricing` pure module: `price(PricingRequest, Catalog) → PricedEstimate`, no I/O, Decimal-only, deterministic                                                                | ✅                                                                                                                                                            |
| 2   | Rules: BOM×region, labor×modifiers (mult-then-add, documented), helper splits, margin vs markup, line-level HALF_UP rounding, job minimums, allowances, good/better/best `option_tiers` | ✅                                                                                                                                                            |
| 3   | Golden-file suite ≥ 40 scenarios                                                                                                                                                        | ✅ 46 scenarios (`tests/pricing/golden/`), byte-pinned; regeneration protocol in ADR-0005                                                                     |
| 4   | Seed catalog v0 ~150 draft assemblies                                                                                                                                                   | ✅ 150 assemblies / 147 SKUs / 12 modifiers across 9 category files + stdlib validator                                                                        |
| 5   | `docs/ASSEMBLY_VALIDATION.md` + CSV export + HUMAN_TODO entry + production enforcement                                                                                                  | ✅ 156-row CSV at `docs/validation/assemblies_v0.csv`; `approved_only()` guard: production companies without `dev_mode` can only see/price `advisor_approved` |
| 6   | Admin endpoint + `/app/admin/assemblies` page (role-gated)                                                                                                                              | ✅ PATCH owner/admin-only, version bump + audit log; web page with search/filter/edit/status flip                                                             |

Extras: `/pricing/preview` endpoint (Phase 5 editor will reuse), hypothesis property tests, Phase 9 hook (`assembly_labor_overrides`) already applied by the engine, ADR-0005.

## 2. Verification block output

```
pnpm turbo lint typecheck test        → Tasks: 12 successful, 12 total
uv run pytest -q                      → 104 passed, 3 skipped (live-DB skips without container)
pytest -m "rls or db" (Postgres 15)   → 23 passed
pytest tests/pricing --cov=fieldquote.pricing --cov-branch --cov-fail-under=100
                                      → Required test coverage of 100% reached. 83 passed
uv run mypy                           → Success: no issues found in 34 source files
alembic upgrade head --sql            → includes 0001 + 0002 (UTF-8 stdout required on Windows)
```

End-to-end smoke against seeded Postgres (labor $145/hr, helper $85, 50% margin, 8.6% tax):
`panel_upgrade_100_200_overhead` + 2 modifiers → **$6,703.00**; `ev_charger_install_tiered`
expands 3 tiers, `best` selected → **$5,019.40**; totals $11,722.40 + $1,008.13 tax; effective
margin exactly 50.0%.

## 3. Test summary

- Pricing engine: 31 hand-computed unit tests + 46 goldens + 6 property tests (hypothesis:
  determinism, non-negative totals, subtotal consistency, qty monotonicity, minimum respected)
  = **100.00% statement AND branch coverage, enforced in CI**.
- API: catalog list/search/patch/role-gate/audit + preview end-to-end + error-envelope mapping
  (6 new live-DB tests), production-guard unit tests (5).
- Totals: 104 unit + 23 live-DB Python tests; 12 turbo tasks green.

## 4. New HUMAN_TODO entries

- Advisor packet is now concrete: send `docs/validation/assemblies_v0.csv`, apply adjustments in
  `/app/admin/assemblies`, flip to `advisor_approved`. (Updated existing standing entry.)

## 5. Known debt

| ID      | Item                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| FQ-D009 | `alembic --sql` needs `PYTHONIOENCODING=utf-8` on Windows consoles (0001 has Unicode comments). CI (Ubuntu) unaffected.         |
| FQ-D010 | Golden regeneration script requires a follow-up `prettier --write` to satisfy the pre-commit hook — fold into the script later. |
| FQ-D011 | Catalog materials list/search endpoint has no pagination (147 rows today; fine until the catalog grows).                        |
| FQ-D004 | (carried) pre-commit runs ruff+prettier but not eslint.                                                                         |

## 6. GO / NO-GO

**GO for Phase 3.** The engine is pure, exhaustively tested, and guarded against placeholder
prices reaching production. Phase 3 (AI pipeline) consumes it via `services/catalog.py` +
`price()` and the typed pricing errors already carry the repair-loop codes it needs.
