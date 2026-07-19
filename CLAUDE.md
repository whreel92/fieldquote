# FIELDQUOTE AI — MASTER BUILD PROMPT FOR CLAUDE CODE

> **How to use this file:** Save as `CLAUDE.md` at the repo root (or paste Phase 0 to start, keeping the full file in the repo for reference). Run **one phase per session**. At the end of each phase, Claude Code must run the phase's verification block and print the Phase Gate Report before you authorize the next phase. Do not let it skip gates or merge phases "for efficiency."

---

## 0. IDENTITY, MISSION, AND OPERATING RULES

You are the lead engineer building **FieldQuote AI**: a mobile-first SaaS for residential service **electricians** (first vertical) that turns job-site **photos + voice dictation** into an editable, trade-correct **scope of work → line-item estimate → branded proposal with e-sign + deposit collection → invoice → follow-up automation → job profitability report**.

You are building this **start to finish in phases**. You own architecture, code, tests, migrations, seed data, docs, and CI. A human (Will) owns: third-party account creation (Stripe, Twilio, Deepgram, Anthropic, Apple/Google developer), real pricing-data validation by licensed electricians, App Store submission, and all legal copy sign-off.

### 0.1 Non-negotiable engineering rules

1. **The LLM never prices.** Language/vision models map speech + photos to a structured catalog of `assemblies`, `quantities`, `modifiers`, `allowances`, and `verify_flags`. **All dollar amounts come from the deterministic pricing engine** reading versioned data tables. If you ever find yourself letting a model emit a price, stop and refactor.
2. **Every generated estimate is a DRAFT.** No estimate can be sent until the contractor explicitly approves it in the editor. This is a legal control, not a UX preference. It must be structurally impossible to send an unreviewed estimate.
3. **Sent documents are immutable.** Proposals and invoices, once sent, are versioned snapshots (stored render + content hash + timestamp). Edits create new versions. Full audit trail: what the AI generated vs. what the human changed vs. what was sent.
4. **Offline-tolerant capture.** Photos and audio are persisted locally on device immediately; upload and generation are queued and retried. A dead zone must never lose a capture.
5. **Streaming UX.** Estimate generation must feel < 60s: stream the scope prose first, then populate line items as the pricing engine resolves them.
6. **Multi-tenant by Row Level Security.** Every table with tenant data carries `company_id`; Supabase RLS policies enforce isolation; service-role access only in server code with explicit tenant scoping. Write RLS tests.
7. **Test what matters.** Pricing engine: exhaustive unit tests (golden files). AI pipeline: contract tests against recorded fixtures (no live API calls in CI). API: integration tests per endpoint. Mobile: component tests for the estimate editor + capture queue. Target: pricing engine 100% branch coverage; overall ≥ 70%.
8. **Conventional commits, small PR-sized commits, one feature branch per phase.** Never commit secrets; `.env.example` documents every variable.
9. **No scope creep.** Explicit non-goals for v1: scheduling/dispatch, GPS/fleet, full accounting, marketing automation beyond follow-up sequences, commercial plan takeoffs, any second trade. If a task drifts toward these, stop and flag.
10. **When blocked on a human dependency** (API key, account, data validation), stub behind an interface + feature flag, record it in `docs/HUMAN_TODO.md` with exact instructions for Will, and continue.

### 0.2 Locked stack (do not relitigate)

| Layer                                                          | Choice                                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Monorepo                                                       | pnpm workspaces + Turborepo; Python backend managed with `uv`                                                              |
| Backend API                                                    | **Python 3.12, FastAPI**, Pydantic v2, SQLAlchemy 2 + Alembic                                                              |
| DB / Auth / Storage / Realtime                                 | **Supabase** (Postgres 15, Supabase Auth JWT, Storage buckets, Realtime channels)                                          |
| Mobile                                                         | **React Native + Expo (SDK latest stable), TypeScript, expo-router**, Zustand state, TanStack Query, react-hook-form + zod |
| Web (marketing + checkout + account portal + hosted proposals) | **Next.js 15 (App Router), TypeScript, Tailwind**                                                                          |
| AI                                                             | Anthropic API (Claude — scoping + vision), Deepgram (ASR primary) with Whisper fallback interface                          |
| Payments (B2C invoices/deposits)                               | **Stripe Connect Express**                                                                                                 |
| Subscriptions                                                  | Stripe Billing (web) + RevenueCat (iOS/Android IAP), unified entitlements service                                          |
| Messaging                                                      | Twilio SMS (A2P 10DLC), Resend email                                                                                       |
| PDF                                                            | Playwright HTML→PDF render service (shared templates with hosted web proposal)                                             |
| Jobs/queue                                                     | Redis + `arq` workers                                                                                                      |
| Observability                                                  | Sentry (API + mobile + web), structured JSON logs, PostHog product analytics                                               |
| CI/CD                                                          | GitHub Actions; Fly.io (API + workers) or Railway; Vercel (web); EAS (mobile builds)                                       |

### 0.3 Repository layout (create exactly this in Phase 0)

```
fieldquote/
├── CLAUDE.md                    # this file
├── docs/
│   ├── ARCHITECTURE.md
│   ├── HUMAN_TODO.md            # running list of Will-actions with instructions
│   ├── DECISIONS/               # ADRs, one file per decision
│   ├── LEGAL_COPY.md            # disclaimers, ToS stubs — DRAFT, lawyer review flag
│   └── PHASE_REPORTS/           # gate report per phase
├── packages/
│   ├── shared-types/            # zod schemas + generated TS types + OpenAPI client
│   └── ui/                      # shared RN/web design tokens (colors, spacing, type)
├── apps/
│   ├── api/                     # FastAPI
│   │   ├── src/fieldquote/
│   │   │   ├── core/            # config, auth, tenancy, errors, logging
│   │   │   ├── domain/          # entities + pure business logic
│   │   │   ├── pricing/         # THE deterministic pricing engine (pure, no I/O)
│   │   │   ├── ai/              # asr/, vision/, scoping/ (all behind interfaces)
│   │   │   ├── routers/
│   │   │   ├── services/
│   │   │   ├── workers/         # arq tasks: generation, pdf, followups, receipts
│   │   │   └── integrations/    # stripe/, twilio/, resend/, revenuecat/, qbo/
│   │   ├── migrations/
│   │   ├── seeds/               # assemblies, materials, labor units, modifiers
│   │   └── tests/
│   ├── mobile/                  # Expo app
│   └── web/                     # Next.js
├── infra/                       # Fly/Railway config, Dockerfiles, supabase/ config
└── .github/workflows/
```

### 0.4 Environment variables (maintain `.env.example` from Phase 0)

`SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_CONNECT_CLIENT_ID, REVENUECAT_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID, RESEND_API_KEY, SENTRY_DSN_{API,MOBILE,WEB}, POSTHOG_KEY, APP_ENV, PUBLIC_WEB_URL, PDF_RENDER_CONCURRENCY`

### 0.5 Phase Gate protocol (run at the end of EVERY phase)

Produce `docs/PHASE_REPORTS/phase-N.md` containing: (1) checklist of deliverables with ✅/❌; (2) command output of the verification block; (3) test summary + coverage; (4) new entries added to `HUMAN_TODO.md`; (5) known debt with ticket stubs; (6) explicit **GO / NO-GO recommendation** for the next phase. Then STOP and wait for authorization.

---

## PHASE 0 — FOUNDATION & SCAFFOLD (target: 2–3 sessions)

**Objective:** Running skeleton of all three apps, DB migrated, CI green, one authenticated round-trip working end to end.

**Deliverables**

1. Monorepo per §0.3 with tooling: `ruff` + `mypy --strict` (api), `eslint` + `prettier` + `tsc --noEmit` (mobile/web), Turborepo pipelines, pre-commit hooks.
2. Supabase project config as code (`infra/supabase/`): initial migration applying the **core schema** (below), RLS enabled on every tenant table, storage buckets `job-photos`, `job-audio`, `documents`, `receipts` (private; signed URL access only).
3. FastAPI app: health route, Supabase JWT verification middleware, tenancy dependency (`get_current_company`), error envelope, structured logging, Sentry, OpenAPI export script → generates typed client into `packages/shared-types`.
4. Expo app: expo-router shell with auth screens (email OTP via Supabase), tab scaffold (`Jobs / Capture / Money / Settings`), design tokens from `packages/ui`, Sentry, PostHog.
5. Next.js app: marketing placeholder, `/login`, `/app` account shell, `/p/[proposalId]` route stub (public hosted proposal).
6. GitHub Actions: lint + typecheck + test on PR for all workspaces; migration check job.
7. `docs/ARCHITECTURE.md` first draft; `docs/HUMAN_TODO.md` seeded (Supabase project, Anthropic key, Deepgram key, Stripe account + Connect application, Twilio A2P 10DLC registration **start now — takes weeks**, Apple/Google dev accounts, RevenueCat project).

**Core schema (initial migration — extend later, never rename casually):**

```
companies(id, name, trade, logo_url, license_number, insurance_line, phone,
          email, address, timezone, settings jsonb, created_at)
users(id ↔ supabase auth uid, company_id, role: owner|admin|tech|office,
      name, phone, created_at)
clients(id, company_id, name, phone, email, address, notes, created_at)
jobs(id, company_id, client_id, title, status: lead|estimating|sent|won|lost|
     in_progress|complete|paid, job_type_code, address, created_by, created_at)
captures(id, job_id, kind: photo|audio, storage_path, duration_s, exif jsonb,
         transcript text, vision_findings jsonb, upload_state, created_at)
estimates(id, job_id, version int, status: draft|approved|superseded,
          source: ai|manual|duplicate, scope_prose text, ai_output jsonb,
          totals jsonb, approved_by, approved_at, created_at)
estimate_lines(id, estimate_id, position, assembly_code nullable, description,
               qty numeric, unit, material_cost, labor_hours, labor_rate,
               line_type: standard|allowance|verify|option_good|option_better|
               option_best|discount, price_source: engine|manual|pricebook,
               confidence: known|allowance|verify, editable_note, totals jsonb)
proposals(id, estimate_id, version, public_token, status: draft|sent|viewed|
          signed|declined|expired, pdf_path, html_snapshot_path, content_hash,
          terms_version, sent_at, first_viewed_at, view_count)
signatures(id, proposal_id, signer_name, signer_email, ip, user_agent,
           signed_at, signature_hash)
invoices(id, job_id, kind: deposit|progress|final, number, status, line_items
         jsonb, subtotal, tax, total, due_at, stripe_payment_intent_id,
         pdf_path, sent_at, paid_at)
payments(id, invoice_id, provider: stripe, amount, fee, net, status, raw jsonb)
followup_sequences(id, company_id, trigger: proposal_unopened_24h|
        proposal_viewed_not_signed_48h|signed_no_deposit_24h|job_complete_review,
        steps jsonb, enabled bool)
followup_events(id, job_id, sequence_id, step_index, channel: sms|email,
        scheduled_at, sent_at, status, error)
job_actuals(id, job_id, kind: receipt|time, amount, hours, description,
        receipt_photo_path, ocr jsonb, created_by, created_at)
audit_log(id, company_id, actor_id, entity, entity_id, action, before jsonb,
        after jsonb, created_at)
-- Pricing data (global, versioned, not tenant-scoped):
material_items(sku, description, unit, category, base_price, price_asof,
        source, region_multipliers jsonb)
assemblies(code, trade, name, description, job_type_codes text[],
        labor_hours numeric, labor_notes, bom jsonb [{sku, qty}],
        modifiers_allowed text[], version, status: draft|advisor_approved)
modifiers(code, name, description, effect jsonb
        e.g. {labor_hours_mult:1.25} or {labor_hours_add:0.5}, version)
company_rates(company_id, labor_rate, helper_rate, target_margin_pct,
        tax_rate_pct, markup_model: margin|markup, overrides jsonb)
subscriptions(company_id, tier: trial|solo|pro|team, seats, source:
        stripe|revenuecat, status, current_period_end, entitlements jsonb)
```

**Verification block**

```bash
pnpm turbo lint typecheck test
cd apps/api && uv run pytest -q && uv run alembic upgrade head --sql | head -5
# manual: sign up on mobile (simulator), hit GET /me → returns user + company
```

**Gate:** all green, RLS tests prove cross-tenant reads fail, OpenAPI client generated. → Report → STOP.

---

## PHASE 1 — DOMAIN CORE: COMPANIES, CLIENTS, JOBS, RATE WIZARD (2 sessions)

**Objective:** A contractor can onboard, brand the company, set rates, create clients and jobs — on mobile.

**Deliverables**

1. API CRUD (+tests): companies (update/branding upload), clients (search-as-you-type), jobs (status machine with guarded transitions; log every transition to `audit_log`).
2. **Onboarding wizard (mobile)** — max 4 screens, < 3 minutes: company + logo + license # → labor rate / helper rate / target margin (with plain-English explainer of margin vs markup and a live example: "a job costing $1,000 will price at $X") → tax + service ZIP → done. Every field skippable with safe defaults; defaults flagged in Settings until confirmed.
3. Jobs tab: list grouped by status, pull-to-refresh, job detail screen (captures/estimates/proposals/invoices sections stubbed), create-job flow (client picker with inline create, address autocomplete via a stubbed geocode interface).
4. Settings: rates editor, branding, team list (invite stub → Phase 8), legal/disclaimer preview.
5. Seed script: demo company + 5 clients + 8 jobs across statuses for development.

**Acceptance:** fresh install → onboarded → job created in ≤ 3 min with zero crashes; rate math explainer verified against unit-tested helper. → Gate report → STOP.

---## PHASE 2 — THE DETERMINISTIC PRICING ENGINE + ELECTRICAL SEED CATALOG (2–3 sessions)

**Objective:** The heart of the product: pure, tested, versioned pricing. **No AI in this phase.**

**Deliverables**

1. `apps/api/src/fieldquote/pricing/` as a **pure module** (no I/O): input = `PricingRequest {assemblies:[{code, qty, modifiers[]}], company_rates, region, adjustments}` → output = `PricedEstimate {lines[], subtotal_material, subtotal_labor, tax, total, margin_check}`. Deterministic: same input → identical output, property-tested.
2. Rules implemented + unit-tested: BOM expansion → material cost × region multiplier; labor_hours × modifiers (multiplicative and additive, applied in documented order) × rate; helper-rate splits where assembly specifies; margin vs markup models; rounding policy (line-level, half-up, documented); minimums (company-configurable job minimum); allowance lines (fixed amount, clearly typed); good/better/best expansion when an assembly defines `option_tiers`.
3. **Golden-file test suite:** ≥ 40 scenarios in `tests/pricing/golden/*.json` (input + expected output). Any engine change that alters a golden file requires an explicit snapshot update commit with rationale.
4. **Seed catalog v0 (PLACEHOLDER DATA — mark every record `status: draft`):** author ~**150 residential electrical assemblies** across: panel/service upgrades (100A→200A variants, meter-main combos, overhead vs underground, relocation), EV chargers (48A/60A, distance tiers, load-calc allowance, panel-full → load-management option), circuits & receptacles (15/20A adds, dedicated appliance, GFCI/AFCI retrofits), fixtures/fans (recessed tiers, fan w/ or w/o existing box), remodel rough-in per-opening units, generator inlets/interlocks, hot tub/mini-split circuits, troubleshooting/service-call diagnostic assemblies, common repairs. Each: BOM (invented-but-plausible SKUs into `material_items` with placeholder prices), labor_hours with a `labor_notes` rationale, allowed modifiers (`occupied_home`, `stucco_exterior`, `two_story`, `attic_run`, `finished_walls`, `crawlspace`, `permit_handling`, `panel_brand_obsolete`…).
5. **`docs/ASSEMBLY_VALIDATION.md`** + CSV export: the exact review packet for Will's licensed-electrician advisors (columns: assembly, labor hours, BOM, notes, approve/adjust). Add to `HUMAN_TODO.md`: _"No production launch until advisors flip assemblies to `advisor_approved`. Placeholder prices must never reach a real customer."_ Enforce in code: companies with `env=production` can only price against `advisor_approved` assemblies unless a `dev_mode` flag is set.
6. Internal admin endpoint + simple web page (`/app/admin/assemblies`, role-gated) to browse/edit catalog with version bump on change.

**Verification:** `uv run pytest tests/pricing -q` → 100% branch coverage on pricing module (enforce in CI via coverage config); golden suite green; property test (hypothesis) for determinism + no negative totals. → Gate → STOP.

---

## PHASE 3 — AI PIPELINE: ASR → VISION → SCOPING (2–3 sessions)

**Objective:** Speech + photos → validated structured scope that feeds the Phase 2 engine. All providers behind interfaces; recorded fixtures for CI.

**Deliverables**

1. **Interfaces:** `ASRProvider` (Deepgram impl + local Whisper fallback impl), `VisionAnalyzer`, `ScopingModel` — each with a `FakeProvider` reading fixtures for tests.
2. **ASR worker:** on audio upload complete → transcribe (electrical vocabulary boost list: "AFCI, GFCI, Zinsco, FPE, meter main, EMT, romex/NM-B, megger, ampacity…") → store transcript on `captures`.
3. **Vision pass (Claude vision):** per photo → structured findings: `{panel: {brand?, amperage?, breaker_spaces?, condition_flags[]}, hazards[], equipment[], environment: {exterior_type?, stories?}, ocr_text[], confidence}`. Prompted to answer **only what is visible**; unknowns are null, never guessed. Store on `captures.vision_findings`.
4. **Scoping model call** (single structured-output call, streaming): system prompt (write it, commit it to `apps/api/src/fieldquote/ai/scoping/prompts/` with version numbers) instructs: map transcript + vision findings + job_type + contractor context onto the **assembly catalog only** (catalog summary provided via tool/context); quantities and modifiers must be justified from the input; anything not inferable → `allowance` or `verify_flag` with a customer-readable reason; produce `scope_prose` in professional, trade-correct, homeowner-readable language; **output schema (zod/Pydantic-validated):**

```json
{
  "job_type_code": "...",
  "assemblies": [
    {
      "code": "...",
      "qty": 1,
      "modifiers": ["stucco_exterior"],
      "evidence": "transcript: 'stucco outside'"
    }
  ],
  "allowances": [
    { "description": "...", "suggested_amount_basis": "labor_only|verify", "reason": "..." }
  ],
  "verify_flags": [{ "item": "ground rod not visible", "action": "verify on site" }],
  "code_notes": [
    { "note": "Zinsco panel flagged — insurer/inspection note", "customer_visible": true }
  ],
  "scope_prose": "...",
  "questions_for_contractor": ["..."]
}
```

5. **Validation + repair loop:** schema-validate model output; unknown assembly codes → one repair retry with the error; still invalid → mark estimate `generation_failed` with a human-readable reason (never surface raw model errors to users).
6. **Generation orchestrator (arq):** `job_id` → gather captures → ASR (if pending) → vision → scoping → **pricing engine** → create `estimates` v1 (`status: draft`, full `ai_output` stored) → Realtime event `estimate.ready` → progressive events (`scope.partial` streamed) for the mobile UX.
7. **Fixture library:** ≥ 12 end-to-end fixtures (synthetic transcripts + photo-findings JSON you author: panel swap, EV charger long run, service call breaker trip, remodel rough-in, hot tub, fan install, ambiguous rambling dictation, non-English snippet, wrong-trade request → graceful "outside supported job types" path, empty audio, photo-only, voice-only). Contract tests assert: valid schema, all codes exist in catalog, allowances used when info is missing, evidence strings map to input.
8. **Eval harness (`apps/api/evals/`):** script that runs the fixture set against the **live** model (manual trigger, not CI), scoring assembly-selection precision/recall vs. expected annotations; writes a markdown scorecard. This is the tool for prompt iteration.
9. Cost/latency instrumentation: per-generation tokens, provider latency, $ estimate logged to PostHog.

**Acceptance:** all fixtures pass contract tests offline; live eval scorecard generated once (add key setup to HUMAN_TODO if key absent); orchestrator survives provider timeouts with retry + dead-letter. → Gate → STOP.

---

## PHASE 4 — MOBILE CAPTURE FLOW (2 sessions)

**Objective:** The 90-second on-site capture experience. This is the product's front door — polish it.

**Deliverables**

1. **Capture screen** (from Job or the center tab): job-type chips (Panel Upgrade, EV Charger, Service Call, Circuits/Outlets, Fixtures/Fans, Remodel, Generator, Other) → **guided shot list per job type** (e.g., Panel Upgrade: panel exterior, panel interior/dead-front off _with safety note_, meter, service entrance, main bonding, surroundings) — skippable, progress dots, thumbnails with retake.
2. **Dictation:** hold-to-talk AND tap-to-toggle; live waveform; pause/resume; multiple takes appended; on-device duration cap 5 min with warning at 4; playback + delete.
3. **Offline queue:** captures persisted to device storage instantly (expo-file-system + SQLite queue); background upload with retry/backoff; visible sync state per item ("3 photos syncing…"); kill-and-relaunch test must not lose data.
4. **Generation UX:** "Generate Estimate" → streaming screen: scope prose streams in → line items populate with subtle count-up totals → lands on the (Phase 5) editor. Failure path: friendly retry + "build manually" escape hatch.
5. Photo hygiene: client-side downscale (long edge 2048px) + EXIF strip on upload; original retained on device until sync confirmed.
6. Empty/edge states: no camera permission, no mic permission, storage full, airplane mode.

**Acceptance:** scripted walkthrough (simulator + at least one physical-device checklist in the report): capture 5 photos + 60s dictation with network disabled → re-enable → auto-sync → generation completes; zero data loss on force-quit mid-capture. → Gate → STOP.

---

## PHASE 5 — THE ESTIMATE EDITOR (2–3 sessions)

**Objective:** The most important screen in the app. A contractor must be able to review, trust, and adjust every number in under 3 minutes.

**Deliverables**

1. **Line list:** grouped (Labor & Materials / Allowances / Verify-on-site / Options); each row: description, qty stepper, unit price, line total; tap → detail sheet showing **the math** ("2.5 hrs × $145 — base 2.0 for 200A meter-main + 0.5 stucco modifier" and BOM with material prices) with per-field override; overridden fields visibly badged `edited` and logged to `audit_log`.
2. **Add line:** search assemblies (fuzzy), recent lines, or free-form manual line (typed `manual`, price_source `manual`).
3. **Confidence UI:** `verify` and `allowance` lines visually distinct with the AI's reason; one-tap convert allowance→priced line after contractor confirms details.
4. **Margin panel:** collapsible footer — cost basis, price, effective margin %, slider to adjust target margin for this estimate only, live total updates. Warning state when margin < company floor.
5. **"What am I forgetting?" action:** re-invokes scoping model in _checklist mode_ against the current line set → returns up to 5 suggestions with reasons; contractor taps to add. (New prompt file, fixtures, tests.)
6. **Options builder:** promote any line/assembly with `option_tiers` into good/better/best; editor for tier labels + prices; proposal renders tiers as selectable.
7. **Approval flow (the legal control):** "Review & Approve" walks section-by-section (scope prose → lines → totals → terms) with per-section confirm; only then `status: approved` and Send unlocks. Approver + timestamp stored. **There must be no code path to send an unapproved estimate — write a test that proves it.**
8. Versioning: editing an approved estimate forks v(n+1) draft; prior versions read-only with diff view (added/removed/changed lines).
9. Performance: 100-line estimate scrolls at 60fps (FlashList), edits optimistic with rollback on API failure.

**Acceptance:** usability script in report (create → edit 6 lines → add allowance → convert → approve) ≤ 3 min; approval-bypass test red-teams the API directly and fails to send a draft. → Gate → STOP.

---

## PHASE 6 — PROPOSALS, E-SIGN, DEPOSITS (STRIPE CONNECT) (2–3 sessions)

**Objective:** Approved estimate → branded proposal → viewed → signed → deposit paid. The revenue moment.

**Deliverables**

1. **Proposal composer (mobile):** cover photo (job photo picker), intro message (AI-drafted from scope, editable), included/excluded sections, deposit config (% or flat, default from company settings), validity period, terms (company terms + **the platform estimate disclaimer — see Legal block below — always appended, non-removable**).
2. **Hosted proposal (`web /p/[token]`):** mobile-first page: branding, scope, line items (options selectable with live total), photos, terms, **Accept & Sign** (typed name + checkbox consent; capture IP/UA/timestamp; store `signature_hash = sha256(content_hash + signer + ts)`), then immediate **Pay Deposit** (Stripe Checkout / Payment Element on the connected account, `application_fee_amount` = platform take, configurable bps). Decline path with optional reason. View tracking (first view, count) → events feed follow-ups.
3. **PDF render worker:** same HTML template → Playwright PDF; stored to `documents`; attached to send email.
4. **Send channels:** email (Resend, branded) + SMS link (Twilio, behind `sms_enabled` flag until A2P approved). All sends logged.
5. **Immutability:** on send — snapshot HTML + PDF + `content_hash`; subsequent edits fork a new proposal version; signed proposals lock the estimate version.
6. **Stripe Connect onboarding (mobile Settings → Get Paid):** Express account link flow, status polling, payouts dashboard deep link. Webhooks: `account.updated`, `checkout.session.completed`, `payment_intent.*` → update `payments`, mark deposit invoice paid, advance job to `won`, fire realtime + push notification ("💰 Sarah signed and paid the $1,200 deposit").
7. Status timeline on job detail: sent → viewed (n) → signed → deposit paid, with timestamps.

**Legal block (commit to `docs/LEGAL_COPY.md`, render on every proposal):**

> _This proposal is an estimate prepared and approved by [Company], a licensed contractor, using FieldQuote software. Final pricing may vary based on site conditions discovered during work; changes will be documented in a written change order. Allowance items are budgetary placeholders. FieldQuote provides drafting software only and is not a party to this agreement._
> Flag in HUMAN_TODO: **attorney review before launch.**

**Acceptance:** full loop on Stripe test mode: approve → send → open on a second device → sign → pay test deposit → job auto-advances → notification received; webhook signature verification tested; replayed webhooks idempotent. → Gate → STOP.

---

## PHASE 7 — INVOICING & PAYMENTS COMPLETION (1–2 sessions)

**Deliverables**

1. Invoice generation from won jobs: deposit (auto-created on signature), progress (% or amount), final (remaining balance auto-computed); numbering `INV-{company_seq}`; edit before send only; immutable after.
2. Hosted pay page (`/i/[token]`) + PDF; card + ACH (ACH fee advantage surfaced to payer); partial payments supported; receipts emailed.
3. Money tab (mobile): outstanding / paid this month / in transit; per-invoice status; nudge action ("remind") that queues a polite SMS/email.
4. Payment reconciliation: fees + net stored from Stripe balance transactions; platform take reported separately (this is your revenue line — instrument it in PostHog).
5. Overdue automation hook (consumed in Phase 8).

**Acceptance:** deposit→progress→final lifecycle green in test mode incl. ACH (test), partial payment, refund path (manual trigger). → Gate → STOP.

---

## PHASE 8 — FOLLOW-UP AUTOMATION + TEAM SEATS (2 sessions)

**Deliverables**

1. **Sequences engine (arq scheduled):** triggers per schema (`proposal_unopened_24h`, `viewed_not_signed_48h`, `signed_no_deposit_24h`, `invoice_overdue_3d`, `job_complete_review`); steps = ordered `{delay, channel, template}` with merge fields; **auto-stop on any terminal event** (signed/paid/declined/manual stop) — test this hard, a follow-up after signing is embarrassing, one after declining is worse.
2. Default sequence library (3 sequences, friendly-professional tone, editable per company); per-job sequence on/off; quiet hours (company timezone, default 8am–7pm) enforced at send time; SMS opt-out handling (STOP) compliant.
3. AI-drafted variants: "rewrite in my voice" using company's prior sent messages as style context (feature-flagged).
4. **Team seats:** invite by email/SMS → role assignment; `tech` can capture + draft, cannot approve/send (approval requires `owner|admin|office` with permission); per-user activity in audit log; seat count enforced by entitlements.
5. Push notifications (Expo): proposal viewed / signed / paid / follow-up replies (inbound SMS surfaced to job timeline via Twilio webhook).

**Acceptance:** time-travel tests (freeze/advance clock) prove trigger timing, quiet hours, and auto-stop; role matrix test grid (4 roles × 8 actions) green. → Gate → STOP.

---

## PHASE 9 — JOB COSTING & PROFITABILITY (1–2 sessions)

**Deliverables**

1. Receipt capture: photo → OCR extraction (vendor, total, date, line guesses) via vision model → confirm/edit → `job_actuals`; multi-receipt; mileage/manual expense entry.
2. Time log: start/stop or manual entry per user per job.
3. **Job P&L:** quoted vs actual (materials, labor hrs × loaded rate), gross margin, variance flags ("materials ran 22% over estimate — biggest line: wire"), shown on job completion + Money tab rollup (monthly margin trend).
4. **Feedback loop v0:** per-assembly variance aggregation _within a company_ ("your actual hours on EV charger installs average 1.3× estimate — adjust?") with one-tap company-level labor override (stored in `company_rates.overrides`, applied by pricing engine — extend engine + goldens). **Cross-company aggregation: schema + opt-in consent flag only, no product surface yet** (this is the future moat; get the data rights UX correct now: explicit toggle, plain-language explanation, off by default).

**Acceptance:** golden tests for override application; P&L math property-tested; OCR fixture suite. → Gate → STOP.

---

## PHASE 10 — MONETIZATION: TRIALS, SUBSCRIPTIONS, ENTITLEMENTS (2 sessions)

**Deliverables**

1. **Entitlements service (single source of truth):** `subscriptions` table fed by Stripe Billing webhooks (web checkout) AND RevenueCat webhooks (IAP); tier → feature map in code (`solo: 1 seat, core loop; pro: +options, +job costing, +sequences editor, +QBO(flagged), 2 seats; team: seats param, +roles/approvals, +company reporting`); API middleware + mobile gating hooks; graceful downgrade behavior defined (data retained read-only, sending blocked).
2. **Trial:** 14-day full-Pro on signup, no card (web variant with card A/B-ready); in-app trial status; paywall screens (mobile: RevenueCat paywall; web: Stripe Checkout at $59/$119/$249 monthly + annual with 2-months-free) — pricing values in config, not hardcoded.
3. Post-trial hard paywall: read-only access + one-tap subscribe; winback email at day 3/10 post-expiry (Resend).
4. Web account portal: plan, seats, billing portal (Stripe), Connect status, invoices.
5. Revenue instrumentation: PostHog funnel `signup → onboarded → first_capture → first_generation → first_send → first_signature → first_payment → subscribe` — this funnel is the company's dashboard; ship a `/app/admin/metrics` page rendering it.

**Acceptance:** entitlement matrix tests; Stripe + RevenueCat webhook replay tests idempotent; trial-expiry time-travel test; a user subscribed on web is entitled on mobile within 60s. → Gate → STOP.

---

## PHASE 11 — MARKETING SITE, HARDENING, LAUNCH PREP (2–3 sessions)

**Deliverables**

1. **Marketing site (Next.js):** hero ("Price the job before you leave the driveway"), 60-second demo section (video placeholder + scripted storyboard file for Will), feature walk (capture → estimate → signed deposit), pricing table, electrician-specific proof section (assembly depth, code flags), FAQ incl. "Is the AI setting my prices?" (answer: no — your rates, your approval, every line editable), founder note, waitlist→trial CTA. SEO: target "electrical estimating app", "electrician quote app", "AI estimate app for electricians"; OG images; sitemap.
2. **Hardening sweep:** rate limiting (per-IP public routes, per-company API), signed-URL expiry audit, webhook signature verification audit, RLS penetration test suite (attempt cross-tenant on every table), dependency audit, load test: 50 concurrent generations (queue depth + latency report), PDF worker concurrency guard, backup/restore runbook (`docs/RUNBOOKS/`).
3. **Store readiness:** EAS production profiles, app icons/splash from `packages/ui`, privacy manifests, App Store/Play listing copy drafts, screenshots plan (6 per platform, storyboarded), TestFlight/internal-track pipeline in CI. (Submission itself → HUMAN_TODO with a step-by-step checklist.)
4. **Beta program tooling:** invite codes, feedback button (screenshot + note → Linear/GitHub issue via webhook), per-company `dev_mode` off, `advisor_approved`-only enforcement verified in prod config.
5. Final docs: `ARCHITECTURE.md` current, `OPERATIONS.md` (deploy, rotate keys, incident basics), `HUMAN_TODO.md` triaged into **LAUNCH BLOCKERS** (advisor validation of assemblies, attorney review of legal copy, A2P approval, Stripe live keys, store review) vs post-launch.

**Final Gate — Launch Readiness Report:** every prior phase's gate re-verified green in CI; LAUNCH BLOCKERS list with owner=Will; smoke script (`scripts/smoke_prod.sh`) that exercises signup→capture→generate→approve→send→sign→pay on a staging environment end to end. → STOP. Launch is a human decision.

---

## APPENDIX A — DEFINITION OF DONE (applies to every task)

Typed end to end (mypy strict / tsc) · tested per §0.1.7 · RLS respected · errors mapped to the error envelope with user-safe messages · loading/empty/error states designed, not defaulted · audit-logged if it mutates money, estimates, or documents · analytics event named per `docs/ANALYTICS_EVENTS.md` (create in Phase 0) · no TODO without a linked HUMAN_TODO or debt entry.

## APPENDIX B — THINGS YOU MUST NEVER DO

Emit model-generated prices · send unapproved estimates · mutate sent documents · store card data · guess at electrical code requirements as fact (flag as notes for the licensed contractor to confirm) · ship placeholder pricing to production · silently swallow webhook failures · add scheduling/dispatch/accounting features "while you're in there."

## APPENDIX C — SESSION PROTOCOL

Start of session: read this file + latest phase report + `HUMAN_TODO.md`; state the phase, the plan for this session, and any blockers. End of session: commit, update phase report progress, list exact next steps. If context runs long, prefer finishing a verifiable slice over starting a new one.
