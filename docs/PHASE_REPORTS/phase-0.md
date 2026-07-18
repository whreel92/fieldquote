# Phase 0 Gate Report — Foundation & Scaffold

Session 1 of Phase 0 (target 2–3 sessions) · 2026-07-18 · branch `phase/0-foundation`

## 1. Deliverables checklist

| #   | Deliverable                                                                                                                                   | Status                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Monorepo per §0.3; ruff + mypy --strict (api), eslint + prettier + tsc (js), Turborepo, pre-commit hooks                                      | ✅                                                                            |
| 2   | Supabase config as code: core schema migration, RLS on every tenant table, 4 private buckets declared                                         | ✅ (buckets in `config.toml`; applied to hosted project once Will creates it) |
| 3   | FastAPI: health, Supabase JWT verify, `get_current_context` tenancy, error envelope, JSON logging, Sentry init, OpenAPI export → typed client | ✅                                                                            |
| 4   | Expo shell: email-OTP auth screens, Jobs/Capture/Money/Settings tabs, tokens from `@fieldquote/ui`                                            | ✅ core · ❌ Sentry/PostHog wiring (no DSN/key yet — next session, FQ-D002)   |
| 5   | Next.js: marketing placeholder, `/login`, `/app`, `/p/[proposalId]`                                                                           | ✅ (prod build passes)                                                        |
| 6   | GitHub Actions: js, api, rls (pg service), migration offline check, OpenAPI-drift check                                                       | ✅ authored · ⚠️ not yet executed on GitHub (no remote configured)            |
| 7   | `ARCHITECTURE.md`, `HUMAN_TODO.md` seeded; plus `ANALYTICS_EVENTS.md`, `LEGAL_COPY.md`, ADR-0001…0004                                         | ✅                                                                            |

## 2. Verification block output

```
$ pnpm turbo lint typecheck test
 Tasks:    12 successful, 12 total          (ui, shared-types, web, mobile × lint/typecheck/test)

$ cd apps/api && uv run pytest -q
 8 passed, 1 skipped (rls suite needs live pg)   · ruff clean · mypy --strict: no issues in 22 files

$ uv run alembic upgrade head --sql | head -5
 BEGIN; CREATE TABLE alembic_version (...)      ← offline SQL generation works

$ sh scripts/test_rls.sh                        (throwaway postgres:15 container)
 8 passed, 8 deselected
```

RLS proof: cross-tenant SELECT returns zero foreign rows; cross-tenant INSERT violates policy;
cross-tenant UPDATE matches 0 rows; anonymous session sees nothing; RLS enabled on all 17 tenant
tables; pricing catalog read-only to `authenticated`. Expo bundle verified via
`expo export --platform web` (all routes compile). OpenAPI client generated and committed
(`packages/shared-types/src/api.gen.ts`), drift-checked in CI.

**Manual check not yet possible:** "sign up on mobile → GET /me returns user + company" requires
the Supabase project (Will, HUMAN_TODO #1). The path is covered by unit tests (auth + /me
contract) and the auto-provision logic (ADR-0004), but must be demonstrated live before the
phase closes.

## 3. Tests + coverage

API: 8 unit + 8 RLS integration; coverage 88% line / branch-on (pricing module empty until
Phase 2, where 100% branch is enforced). JS: no meaningful tests yet (shells only) — component
tests arrive with real components per §0.1.7.

## 4. HUMAN_TODO added this phase

Supabase project (+ env vars, migration apply), Anthropic key, Deepgram key, Stripe + Connect
application, **Twilio A2P 10DLC — flagged start-now/2–6 weeks**, Resend + domain, Apple/Google
developer accounts, RevenueCat, Sentry, PostHog. Standing: electrician advisors, attorney review.

## 5. Known debt

| ID      | Item                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FQ-D001 | `JwksVerifier` for asymmetric Supabase keys (interface ready; before staging)                                                                                                  |
| FQ-D002 | Mobile Sentry + PostHog wiring behind config-absent no-op                                                                                                                      |
| FQ-D003 | Integration test for real `get_current_context` path (auto-provision) against live pg — extend RLS suite                                                                       |
| FQ-D004 | Pre-commit hook covers ruff + prettier only; eslint runs in CI, not locally                                                                                                    |
| FQ-D005 | Turbo `test` placeholders in JS workspaces until first real components                                                                                                         |
| FQ-D006 | Stack drift note: create-next-app delivered Next 16 / create-expo-app SDK 57 (spec text says "15 / latest stable" — both are current stable; no action, recorded for accuracy) |

## 6. GO / NO-GO recommendation

**Phase 0 is not closed — one residual slice remains.** Recommendation: **NO-GO for Phase 1**
until, in the next session: (a) Will provisions the Supabase project and the live
sign-up → `/me` round-trip is demonstrated, (b) FQ-D002 observability wiring lands, (c) repo is
pushed to GitHub and CI runs green there. All are small; Phase 0 should close in one more
session. Everything else in this report is verified green locally.

### Exact next steps

1. Will: HUMAN_TODO Phase 0 items — minimum the Supabase project.
2. Push `phase/0-foundation` to a GitHub repo; confirm all 5 CI jobs green.
3. Wire mobile Sentry/PostHog no-op stubs; live round-trip on simulator; re-run gate; close Phase 0.
