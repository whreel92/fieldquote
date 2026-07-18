# Phase 1 Report — Domain Core (in progress)

Session 1 of 2 · 2026-07-18 · branch `phase/1-domain-core`

## Deliverables checklist

| #   | Deliverable                                                                                                                                                                                                                                    | Status                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | API CRUD + tests: companies (update + branding upload URL), clients (search-as-you-type), jobs (guarded status machine, every transition audit-logged)                                                                                         | ✅                                             |
| 2   | Mobile onboarding wizard — 4 screens, all fields skippable, margin/markup plain-English explainer with live example                                                                                                                            | ✅ built · ⏳ timed device walkthrough pending |
| 3   | Jobs tab: list grouped by status (colored sections, pull-to-refresh), job detail (transition buttons + stub sections for captures/estimates/proposals/invoices), create-job flow (client picker with inline create, stubbed geocode interface) | ✅ built · ⏳ device walkthrough pending       |
| 4   | Settings: rates editor (default-rates warning badge), branding editor, team stub, legal/disclaimer preview                                                                                                                                     | ✅                                             |
| 5   | Seed script: demo company + 5 clients + 8 jobs across all statuses, idempotent                                                                                                                                                                 | ✅ (verified twice against fresh Postgres)     |

## What was built

**API** (`apps/api`): `GET/PATCH /company`, `GET/PUT /company/rates` (defaults flagged
`confirmed:false` until the wizard confirms), `POST /company/logo-upload-url` (Supabase Storage
signed upload behind a `StorageService` interface with fake), full clients CRUD with
`?search=` across name/phone/email, jobs CRUD plus `POST /jobs/{id}/transition` enforcing the
status machine in `domain/job_status.py`:

```
lead → estimating → sent → won → in_progress → complete → paid
  ↘lost ↘lost ↘lost  ↘lost                 lost → lead (reopen)
```

Invalid moves return the 409 envelope with the allowed targets. Every create/update/delete/
transition writes `audit_log` in-transaction. Cross-tenant access returns 404 (proven by tests,
including attaching another company's client to a job).

**Mobile** (`apps/mobile`): typed API client consuming the generated OpenAPI types with the
error envelope surfaced as user-safe messages; onboarding gate in the root layout
(auth → not-onboarded → wizard → tabs); the four wizard screens; jobs SectionList grouped by
status with the token status colors; create-job with debounced client search + inline create;
job detail with one-tap allowed transitions; settings editors. Rate explainer uses the
unit-tested `@fieldquote/shared-types` helper (margin vs markup, effective-margin note).

## Tests

- API: 16 unit (auth matrix incl. ES256/JWKS, status-machine exhaustive matrix, /me contract)
  - 17 live-Postgres integration (8 RLS isolation + 9 CRUD/tenancy/audit) — all green locally.
- shared-types: 11 vitest tests on the rate math helper.
- Full `pnpm turbo lint typecheck test`: 12/12; mobile bundle verified via `expo export`
  (web output switched to SPA — static SSR prerender can't host AsyncStorage; ADR-worthy note
  recorded here: native is the product, web export is a dev convenience).

## Remaining for Phase 1 gate (session 2)

1. Acceptance walkthrough on simulator/device: fresh install → onboard → create job in ≤ 3 min,
   zero crashes (needs a machine with Android Studio emulator or a physical device via Expo Go).
2. Logo upload UI in wizard/branding (endpoint live; mobile image picker not yet wired — small).
3. ~~CI green on `phase/1-domain-core`~~ ✅ run #4: all 5 jobs passed (JS, API, RLS suite,
   migration check, OpenAPI drift).

## Notes / debt

- FQ-D007: onboarding wizard writes `settings.onboarded`; team invites (Phase 8) must set
  company before first `/me` (ADR-0004 consequence still holds).
- FQ-D008: client search is ILIKE; move to trigram/tsvector if lists grow past a few thousand.
- Hosted `DATABASE_URL` still pending Will's password reset (HUMAN_TODO) — all Phase 1 work
  verified against local Postgres 15 containers.
