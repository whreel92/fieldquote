# FieldQuote — Project Status Report

**Date:** 2026-07-18 · **Repo:** github.com/whreel92/fieldquote · **Branch:** `phase/1-domain-core`
(9 commits ahead of `main`) · **Build plan:** `CLAUDE.md` (12 phases, 0–11)

---

## 1. Executive summary

FieldQuote turns an electrician's job-site photos + voice notes into priced estimates, signed
proposals with deposits, invoices, and job profitability reports. The build is **2 phases into a
12-phase plan** and ahead of the curve on infrastructure quality: CI is green on GitHub (5 jobs
including a live-Postgres tenant-isolation suite), the hosted Supabase project is live with
verified auth, and the founder has personally exercised the core flow (signed in, created a job,
moved it through the pipeline) in a working build. The app has a distinctive "panel-rail" visual
identity. **The heart of the product — the deterministic pricing engine and the AI capture
pipeline — is not yet built; that's Phases 2–5.**

Bottom line: foundation and domain core are real, tested, and running. Everything revenue-shaped
(pricing, AI estimates, proposals, payments) is still ahead.

## 2. What exists today (verified working)

### Infrastructure (Phase 0 — CLOSED, gate report `docs/PHASE_REPORTS/phase-0.md`)

- **Monorepo**: pnpm + Turborepo. `apps/api` (Python 3.12/FastAPI/uv), `apps/mobile`
  (Expo SDK 57/expo-router/TypeScript), `apps/web` (Next.js 16/Tailwind), `packages/ui`
  (design tokens), `packages/shared-types` (zod + generated OpenAPI client), `infra/supabase`.
- **Database**: 20-table core schema (companies→payments, pricing catalog tables) in one
  canonical SQL migration applied by both Supabase CLI and Alembic. **RLS enforced on all 17
  tenant tables** with denormalized `company_id` — proven by an 8-test isolation suite against
  live Postgres (cross-tenant reads return nothing, writes blocked, catalog read-only).
- **Auth**: Supabase JWT verification supporting both HS256 (local) and ES256/JWKS (hosted —
  discovered the hosted project signs asymmetrically and shipped the JWKS path early).
- **CI (GitHub Actions, all green)**: JS lint/typecheck/test · API lint/mypy-strict/pytest ·
  RLS suite w/ Postgres service · migration offline check · OpenAPI-client drift check.
  (Actions was silently disabled by a $0 account-level budget; diagnosed and fixed.)
- **Hosted Supabase live**: project `qamhpzoxojpduqiktbpf` — auth verified end-to-end with real
  tokens, 4 private storage buckets provisioned, `localhost:8081` allowed for magic-link
  redirect.

### Product (Phase 1 — functionally complete, gate ~closable; `docs/PHASE_REPORTS/phase-1.md`)

- **API**: company profile + rates (defaults flagged until confirmed), logo signed-upload
  endpoint, clients CRUD with search-as-you-type, jobs CRUD with a **guarded status machine**
  (`lead→estimating→sent→won→in_progress→complete→paid`, lost/reopen; illegal moves 409 with
  allowed targets). Every mutation writes `audit_log`. Idempotent demo seed script.
- **Mobile app**: email sign-in (magic link + code), 4-screen onboarding wizard with the
  margin-vs-markup explainer (unit-tested helper: "a $1,000 job prices at $2,000 at 50%
  margin"), jobs pipeline list, create-job flow with inline client creation, job detail with
  one-tap status transitions, settings (rates/branding/legal/team-stub).
- **Web**: marketing placeholder, `/login`, `/app` shell, `/p/[proposalId]` route stub.
- **Design identity**: "Trust & Authority" system (ui-ux-pro-max) + "panel-rail" signature
  (frontend-design): ink header bands with equipment-label eyebrows + safety-orange rule,
  breaker-directory job rows with status rails, lucide icons, Plus Jakarta Sans + JetBrains
  Mono numerals. Persisted in `design-system/fieldquote/MASTER.md`.
- **Real-user validation**: Will onboarded and ran a job through the pipeline in the live dev
  build ("Panel Upgrade" → Won).

### Test & quality posture

| Layer                               | Count | Notes                                                           |
| ----------------------------------- | ----- | --------------------------------------------------------------- |
| API unit tests                      | 25    | auth matrix (HS256+ES256), status-machine exhaustive, contracts |
| API live-DB integration             | 17    | 8 RLS isolation + 9 CRUD/tenancy/audit                          |
| shared-types (vitest)               | 11    | rate math margin/markup                                         |
| CI jobs                             | 5     | all green on `main` and `phase/1-domain-core`                   |
| mypy --strict / ruff / eslint / tsc | clean | across all workspaces                                           |

~4,700 lines of first-party Py/TS across 25 commits. Mobile/web component tests: none yet
(deferred until estimate editor + capture queue per §0.1.7 — that's by design, not neglect).

## 3. Open items on current phases (small)

1. **Phase 1 gate formalities**: logo image picker UI (API endpoint already live); formal timed
   walkthrough on a _native_ device (web walkthrough done by Will); final gate report update.
2. **`main` branch** is 9 commits behind — fast-forward when Phase 1 gate closes.

## 4. Blocked on Will (HUMAN_TODO — full detail in `docs/HUMAN_TODO.md`)

| Item                                                                                                                                                     | Blocks                                                   | Effort         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------- |
| **Reset hosted DB password** to the value in `.env` (dashboard → Settings → Database) — then schema applies to the hosted DB                             | staging/production runtime (not Phase 2 dev)             | 1 min          |
| **Resend account + domain** → custom SMTP in Supabase → unlocks editable email templates (today's emails send a link, not a code — workarounds in place) | polished auth emails; Phase 6 proposal emails            | ~30 min + DNS  |
| **Twilio A2P 10DLC registration** — carrier vetting takes 2–6 weeks; **start now**                                                                       | Phase 6/8 SMS                                            | start now      |
| Stripe account + Connect application                                                                                                                     | Phase 6 (e-sign deposits)                                | ~30 min        |
| Apple Developer + Google Play accounts                                                                                                                   | Phase 4 device builds; Phase 11 stores                   | days (D-U-N-S) |
| RevenueCat / Sentry / PostHog accounts                                                                                                                   | Phase 10 / observability                                 | quick          |
| Recruit 2–3 licensed electrician advisors                                                                                                                | **launch blocker** — catalog validation (Phase 2 output) | ongoing        |
| Attorney review of `docs/LEGAL_COPY.md`                                                                                                                  | launch blocker                                           | before launch  |
| Rotate the Supabase dashboard password (it was pasted into chat)                                                                                         | hygiene                                                  | 2 min          |

Already provided: Supabase keys ✓, Anthropic API key ✓, Deepgram key ✓ (Phase 3 is unblocked).

## 5. Technical debt registry

| ID      | Item                                                                                                               | Status                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| FQ-D001 | JWKS verifier for hosted Supabase                                                                                  | ✅ closed (shipped in Phase 0 close-out)              |
| FQ-D002 | Mobile Sentry/PostHog                                                                                              | stub facade live; real SDK wiring when DSN/keys exist |
| FQ-D003 | Tenancy auto-provision integration test                                                                            | ✅ covered by live-DB suite                           |
| FQ-D004 | Pre-commit hook runs ruff+prettier but not eslint                                                                  | open (eslint runs in CI)                              |
| FQ-D005 | Turbo `test` placeholders in ui/web/mobile workspaces                                                              | open until first component tests                      |
| FQ-D007 | Team invites must attach company before invitee's first `/me` (ADR-0004)                                           | design note for Phase 8                               |
| FQ-D008 | Client search is ILIKE; needs trigram index at scale                                                               | open, low                                             |
| —       | Detached Metro dev server doesn't watch file changes reliably on Windows (restart with `--clear` to pick up edits) | dev-env quirk, documented                             |
| —       | Expo web output switched to SPA (`single`) — SSR prerender incompatible with AsyncStorage                          | intentional; native is the product                    |

## 6. What's left: the remaining 10 phases

| Phase                                     | Scope (from CLAUDE.md)                                                                                                                                                                                                                                                                                                                                                 | Est. sessions |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **2 — Pricing engine + catalog** _(next)_ | Pure deterministic engine (BOM × region, labor × modifiers, margin/markup, rounding, minimums, good/better/best); ≥40 golden-file tests, 100% branch coverage enforced; ~150 placeholder electrical assemblies (panels, EV chargers, circuits, fixtures, generators…); advisor validation packet; admin catalog browser; production guard against non-approved pricing | 2–3           |
| **3 — AI pipeline**                       | ASR (Deepgram + Whisper fallback), Claude vision findings, scoping model with strict schema + repair loop, generation orchestrator (arq), ≥12 contract-test fixtures, live eval harness, cost instrumentation. **The LLM never prices — it only maps to catalog codes.**                                                                                               | 2–3           |
| **4 — Mobile capture**                    | Guided shot lists per job type, hold-to-talk dictation, offline queue (SQLite, survives force-quit), streaming generation UX, photo hygiene, permission edge states                                                                                                                                                                                                    | 2             |
| **5 — Estimate editor**                   | The money screen: grouped lines with "show the math" detail sheets, add/search lines, confidence UI, margin panel, "what am I forgetting?", options builder, **structurally-enforced approval flow** (no code path sends a draft), versioning + diff                                                                                                                   | 2–3           |
| **6 — Proposals, e-sign, deposits**       | Hosted proposal page, typed-name signature with hash, Stripe Connect Express onboarding + deposit checkout with platform fee, PDF worker, immutable send snapshots, email/SMS send                                                                                                                                                                                     | 2–3           |
| **7 — Invoicing**                         | Deposit/progress/final lifecycle, hosted pay page with ACH, partial payments, Money tab, reconciliation                                                                                                                                                                                                                                                                | 1–2           |
| **8 — Follow-ups + team**                 | Sequence engine with hard auto-stop tests, quiet hours, STOP compliance, team seats/roles, push notifications                                                                                                                                                                                                                                                          | 2             |
| **9 — Job costing**                       | Receipt OCR, time log, job P&L with variance flags, per-assembly feedback loop, consent-gated benchmarking schema                                                                                                                                                                                                                                                      | 1–2           |
| **10 — Monetization**                     | Entitlements service (Stripe Billing + RevenueCat), 14-day trial, paywalls, $59/$119/$249 tiers, funnel dashboard                                                                                                                                                                                                                                                      | 2             |
| **11 — Launch prep**                      | Real marketing site, hardening sweep (rate limits, RLS pen-test, load test), store readiness, beta tooling, launch-blocker triage                                                                                                                                                                                                                                      | 2–3           |

**Rough remaining effort: 19–25 build sessions**, plus Will's parallel items above. The
long-lead external dependencies (A2P vetting, Apple D-U-N-S, advisor recruitment) are the
schedule risks — none block the next ~4 phases of engineering.

## 7. Non-negotiables holding firm (worth re-stating)

The LLM never prices · estimates are drafts until explicitly approved (structurally enforced,
tested) · sent documents immutable · offline capture never loses data · RLS everywhere ·
placeholder prices never reach production. These are architecture commitments already visible in
the schema (`advisor_approved` status, estimate versioning, audit log) — not aspirations.

## 8. Recommendation

Close the Phase 1 gate (logo picker + native walkthrough are an hour of work), fast-forward
`main`, and start **Phase 2** — it's pure deterministic Python with no external dependencies,
fully unblocked, and it's the moat. In parallel, Will: DB password reset (1 min), Resend
account, and _start the Twilio A2P registration this week_ — it's the longest external clock in
the entire plan.
