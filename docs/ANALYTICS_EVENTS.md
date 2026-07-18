# Analytics events (PostHog)

Naming: `snake_case`, `object_verb` order, past tense. Every event carries `company_id`,
`user_id`, `app` (mobile|web|api) automatically. Add events here BEFORE instrumenting them.

## Funnel (the company dashboard — CLAUDE.md Phase 10)

| Event                  | Fired when                    | Key properties                              |
| ---------------------- | ----------------------------- | ------------------------------------------- |
| `signup_completed`     | first successful auth session | `method`                                    |
| `onboarding_completed` | rate wizard finished          | `used_defaults`                             |
| `capture_created`      | photo/audio saved locally     | `kind`, `job_type_code`                     |
| `generation_completed` | estimate v1 lands             | `duration_ms`, `line_count`, `verify_count` |
| `estimate_approved`    | contractor approves           | `edited_line_count`, `total`                |
| `proposal_sent`        | send succeeds                 | `channel`                                   |
| `proposal_signed`      | signature stored              | `hours_since_send`                          |
| `deposit_paid`         | webhook confirms payment      | `amount`, `method`                          |
| `subscription_started` | Stripe/RevenueCat webhook     | `tier`, `source`                            |

## Operational

| Event                 | Fired when                                                               |
| --------------------- | ------------------------------------------------------------------------ |
| `generation_failed`   | AI pipeline gives up after retries                                       |
| `generation_cost`     | per generation: `tokens_in`, `tokens_out`, `usd_estimate`, `asr_seconds` |
| `capture_sync_failed` | upload retry exhausted                                                   |
| `webhook_replayed`    | idempotency short-circuit hit                                            |

Phase 0 note: no events are instrumented yet; PostHog key is optional until staging.
