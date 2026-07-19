# Phase 7 Gate Report — Invoicing & Payments Completion

**Date:** 2026-07-19 · **Branch:** `phase/6-proposals-payments` · **Sessions:** 2

## 1. Deliverables

| #   | Deliverable                                                                                                                                                                                            | Status                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Invoice generation from won jobs: deposit (auto on signature, Phase 6), progress (% or amount), final (remaining balance auto-computed); `INV-{seq}` numbering; draft-only edits; immutable after send | ✅ `services/invoicing.py` + `routers/invoices.py`; over-invoicing the contract balance rejected                                                                                                                                            |
| 2   | Hosted pay page `/i/[token]` + PDF; card + ACH (fee advantage surfaced); partial payments; receipts emailed                                                                                            | ✅ public router + Next.js pay page (full/other amount, card vs ACH w/ "lower fees, settles 4–5 days" note); receipt email per settled payment                                                                                              |
| 3   | Money tab (mobile): outstanding / paid this month / in transit; per-invoice status; remind nudge                                                                                                       | ✅ Money tab (prev session) + new invoice detail screen (`app/invoice/[id]`): payments incl. refunds, share/open pay link, Send a reminder, Refund (double-confirmed)                                                                       |
| 4   | Payment reconciliation: fees + net from Stripe balance transactions; platform take reported separately (PostHog)                                                                                       | ✅ `get_payment_breakdown` (expand `latest_charge.balance_transaction` on the connected account) with platform-fee-estimate fallback; `payment_collected` event carries amount/fee/net/platform_fee                                         |
| 5   | Overdue automation hook (consumed in Phase 8)                                                                                                                                                          | ✅ `invoicing.overdue_invoices(db, as_of=…)`; public view + Money tab surface `overdue`                                                                                                                                                     |
| —   | Refund path (manual trigger)                                                                                                                                                                           | ✅ `POST /invoices/{id}/refund` (owner/admin) → Stripe refund on connected account (`refund_application_fee`), negative payment row, status rolls to partial/paid/refunded; `charge.refunded` webhook reconciles by refund id (replay-safe) |

Migration `0004` (shared SQL with Supabase CLI): invoice status check now
`draft | sent | partial | paid | overdue | refunded | void`.

## 2. Verification

```
uv run ruff check .                    → clean
uv run mypy src tests                  → clean (96 source files)
uv run pytest -q                       → 149 passed, 8 skipped
sh scripts/test_rls.sh (Postgres 15)   → 56 passed  (rls + db suites)
pnpm turbo lint typecheck test         → 12/12 tasks green (api types regenerated)
```

**Money-loop integration proof** (`test_invoices_db.py`, FakeStripe, live Postgres):

- _Lifecycle_: signed proposal → deposit $1,000 → progress 25% ($1,000, draft → send locks:
  PATCH after send 409) → final auto-computes $2,000 remaining → summary outstanding $2,000.
- _Hosted pay_: public `/i/{token}` view (branding, balance, methods) → **partial ACH
  checkout $400** → `checkout.session.completed` → status `partial`, payment recorded with
  **real balance-transaction economics** (fee $21.90 = 2.9%+30¢ + $10 platform, net $378.10),
  receipt queued → remind queues a nudge → card checkout clears $600 → `paid`, second
  receipt → pay/remind on a paid invoice 409 → **manual refund $200** → status `partial`,
  `-200.00` row, Stripe refund issued → **replayed `charge.refunded` is a no-op** (refund-id
  dedup) → over-refund 409. Payment-intent-level dedup protects against
  checkout+payment_intent double-fire; bad amounts/tokens 404/409.
- _Delivery_ (fakes): send enqueues worker → PDF rendered + stored (`documents` bucket),
  pay-link email to client, polite reminder email, receipt shows amount + "paid in full",
  reminder skipped once nothing is owed.

## 3. Security / correctness posture

- Public router exposes only token-keyed, sent invoices; drafts have no token and 404.
- Checkout amount validated server-side ($0.50 min, ≤ balance); application fee recomputed
  from bps on the charged amount — the payer can never set the fee.
- Sent invoices immutable; refunds are new negative payment rows, never edits.
- Refund requires `owner|admin`; audit-logged (create/update/send/remind/refund all are).
- Webhook failures still re-raise (Stripe retries); receipt enqueue is best-effort and
  never fails the ack.

## 4. New HUMAN_TODO entries

- Enable ACH (US bank accounts) for the platform + Connect in the Stripe dashboard.
- Subscribe the webhook endpoint to `charge.refunded` (in addition to the Phase 6 events).

## 5. Known debt

| ID      | Item                                                                                                                                                                                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FQ-D025 | ACH payments can sit `processing` for days; the pay page shows a processing note on return, but there is no `payment_intent.processing` handler — invoice stays `sent/partial` until success/failure webhook lands (acceptable; revisit if payers get confused) |
| FQ-D026 | Partial-payment "requests" are payer-driven (any amount ≥ $0.50); contractor-defined installment schedules are out of scope                                                                                                                                     |
| FQ-D027 | `overdue` is computed at read time; a scheduled status flip + `invoice_overdue_3d` trigger lands with the Phase 8 sequences engine via `invoicing.overdue_invoices`                                                                                             |
| FQ-D022 | (carried) Playwright Chromium not installed; invoice PDFs fall back to no-PDF until `playwright install chromium` on the worker host                                                                                                                            |

## 6. GO / NO-GO

**GO for Phase 8.** The deposit→progress→final lifecycle incl. ACH, partial payment, and
refund is green in test mode end to end. Follow-up automation has its hooks: view/sign/pay
events feed `followup_events` triggers, `overdue_invoices` is ready for the scheduler, and
reminder delivery (email/SMS behind the A2P flag) already runs through the worker.
