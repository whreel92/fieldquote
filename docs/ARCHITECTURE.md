# FieldQuote Architecture (Phase 0 draft)

Mobile-first SaaS for residential electricians: photos + dictation → scope → priced estimate →
signed proposal + deposit → invoice → follow-ups → job P&L. See `CLAUDE.md` for the full build
plan; this doc describes how the system is put together.

## Monorepo

```
apps/api        FastAPI (Python 3.12, uv). Owns all business logic, pricing, AI orchestration.
apps/mobile     Expo / React Native. Contractor-facing app (capture, editor, money).
apps/web        Next.js. Marketing, hosted proposals /p/[token], pay pages, account portal.
packages/ui     Design tokens shared RN ↔ web.
packages/shared-types  zod schemas + TS client generated from the API's OpenAPI spec.
infra/supabase  Supabase config-as-code + canonical SQL migrations.
```

pnpm workspaces + Turborepo run JS lint/typecheck/test; the Python API is driven by `uv` and has
its own CI jobs.

## Core principles (from CLAUDE.md §0.1 — enforced structurally)

1. **LLM never prices.** AI maps input → assembly codes/quantities/modifiers; the deterministic
   pricing engine (`apps/api/src/fieldquote/pricing/`, pure, no I/O) produces every dollar amount.
2. **Estimates are drafts until explicitly approved**; sending is impossible pre-approval.
3. **Sent documents are immutable** versioned snapshots (content hash + stored render).
4. **Offline-tolerant capture** on device; uploads queue and retry.
5. **Multi-tenant via RLS**: every tenant table carries `company_id` (denormalized on child
   tables — ADR-0003) with a uniform policy `company_id = current_company_id()`.

## Data & tenancy

- Postgres 15 on Supabase. Canonical schema: `infra/supabase/migrations/*.sql`, applied
  identically by the Supabase CLI and Alembic (ADR-0002).
- Supabase Auth issues JWTs; mobile talks to Supabase directly only for auth + storage
  upload/download via signed URLs. All business reads/writes go through the API.
- The API connects with a privileged role (bypasses RLS) and scopes every query by the tenant
  resolved in `core/tenancy.py` from the verified JWT. RLS is the second wall protecting direct
  Supabase access from clients; `tests/test_rls.py` proves isolation per table.
- Global pricing catalog tables (`assemblies`, `material_items`, `modifiers`) are readable by all
  authenticated users, writable only by service role.

## API layout

```
core/         config (pydantic-settings), auth (JWT verify), tenancy, errors, db, logging
domain/       SQLAlchemy models (only tables the API touches; grows per phase)
pricing/      deterministic engine (Phase 2) — pure functions, golden-file tested
ai/           asr/ vision/ scoping/ — provider interfaces + fakes; no live calls in CI
routers/      HTTP endpoints; every response error uses the envelope
services/     use-case orchestration between routers and domain
workers/      arq tasks (generation, pdf, follow-ups, receipts)
integrations/ stripe, twilio, resend, revenuecat, qbo
```

Error envelope: `{"error": {"code", "message", "details"}}` — machine code + user-safe message.
Logging: single-line JSON to stdout. Sentry enabled when `SENTRY_DSN_API` is set.

## Type flow

FastAPI → `scripts/export_openapi.py` → `openapi.json` → `openapi-typescript` →
`packages/shared-types/src/api.gen.ts` (committed; CI fails if it drifts). Hand-written zod
schemas in `shared-types` cover shared enums and the error envelope.

## Environments

`APP_ENV = development | staging | production | test`. All secrets via env (`.env.example` is the
authoritative list). Production must never price against non-`advisor_approved` assemblies
(enforced from Phase 2).

## Deploy targets (wired in later phases)

Fly.io/Railway (API + arq workers + Playwright PDF renderer), Vercel (web), EAS (mobile),
Supabase (managed Postgres/auth/storage/realtime).
