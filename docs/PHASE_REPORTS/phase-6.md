# Phase 6 Gate Report — Proposals, E-Sign, Deposits (Stripe Connect)

**Date:** 2026-07-19 · **Branch:** `phase/6-proposals-payments` · **Sessions:** 1

## 1. Deliverables

| #   | Deliverable                                                                                                                                                                                                         | Status                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Proposal composer (mobile): cover, intro (AI-drafted, editable), inclusions/exclusions, deposit config, validity, terms + non-removable disclaimer                                                                  | ✅ composer screen; config PATCH while draft; live document preview                                       |
| 2   | Hosted proposal (web `/p/[token]`): branding, scope, selectable options, Accept & Sign (typed name + consent, IP/UA/ts, `signature_hash`), Pay Deposit (Connect Checkout + application fee), decline, view tracking | ✅ public API + web page                                                                                  |
| 3   | PDF render worker (Playwright, shared HTML template)                                                                                                                                                                | ✅ behind interface; worker renders + stores, falls back to HTML snapshot when Chromium absent            |
| 4   | Send channels: email (Resend) + SMS (Twilio, `sms_enabled` flag)                                                                                                                                                    | ✅ behind interfaces + fakes; delivery worker task                                                        |
| 5   | Immutability: send snapshots HTML + `content_hash`; edits fork; signed proposals lock estimate                                                                                                                      | ✅ frozen snapshot + sha256 content hash; sent proposals reject edits (`already_sent`); new-version forks |
| 6   | Stripe Connect onboarding + status polling; webhooks (`account.updated`, `checkout.session.completed`, `payment_intent.*`) idempotent → payments, deposit paid, job → won, notification                             | ✅ onboarding + status; idempotent webhook receiver (event ledger); job auto-advances                     |
| 7   | Status timeline on job detail (sent → viewed → signed → paid)                                                                                                                                                       | ✅ (mobile) proposal timeline                                                                             |

Legal disclaimer + e-sign consent rendered verbatim from `docs/LEGAL_COPY.md` (attorney review still flagged in HUMAN_TODO).

## 2. Verification

```
uv run ruff / mypy                    → clean (69 source files)
uv run pytest -q                      → 149 passed
pytest -m "rls or db" (Postgres 15)   → 53 passed
pnpm turbo lint typecheck test        → (all workspaces; see §4)
```

**Money-loop integration proof** (`test_proposals_db.py`, Stripe faked, live Postgres):
approve → create proposal → configure → **send freezes an immutable snapshot** (content_hash
set, HTML archived; editing/re-send now 409) → public view (draft hidden, view count tracked) →
sign (consent required; 64-char signature_hash; deposit invoice auto-created, fee $25 on $1000) →
Connect onboard → `account.updated` webhook enables charges → checkout (blocked until ready) →
`checkout.session.completed` webhook → **invoice paid, payment recorded (net $975 after fee),
job → won** → **replayed event is idempotent** (no second payment). Bad signatures 400; decline
and double-sign paths covered.

**Pure unit tests** (`test_proposal_render.py`): content-hash determinism + sensitivity,
signature-hash binding, deposit math (percent/flat/capped), Stripe webhook HMAC verification
(tamper / wrong-secret / stale-timestamp / malformed all rejected).

## 3. Security / correctness posture

- **RLS**: proposals, signatures, invoices, payments inherit the proven uniform per-`company_id`
  tenant policy (Phase 0). `webhook_events` is a global service-role-only ledger (no
  `authenticated` grant).
- **Never prices**: proposal totals come from the frozen estimate; the composer only styles.
- **Immutable sent docs**: content_hash over canonical render-model JSON; signature binds to it.
- **Webhook safety**: signature-verified, idempotent by event id, handler failures re-raised
  (Stripe retries) — never silently swallowed.
- Stripe/Resend/Twilio all behind interfaces with fakes; unconfigured envs degrade gracefully
  (hosted page shows "contractor will follow up for the deposit"; SMS off until A2P approved).

## 4. Known debt

| ID      | Item                                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FQ-D022 | Playwright Chromium not installed in CI; PDF path exercised only via FakePdf. Worker falls back to HTML snapshot in prod until `playwright install` is run      |
| FQ-D023 | Push notification on deposit-paid is emitted as a realtime/log event; Expo push wiring is Phase 8                                                               |
| FQ-D024 | Local test container accumulates rows across runs; FakeStripe now uses uuid ids and test event ids are uuid-suffixed to avoid collisions (CI is fresh each run) |

## 5. GO / NO-GO

**GO for Phase 7.** Deposit invoices, payments, and reconciliation fields (fee/net) exist;
Phase 7 (progress/final invoices, hosted pay page, ACH, Money tab) extends `services/invoicing.py`
and the same webhook receiver.
