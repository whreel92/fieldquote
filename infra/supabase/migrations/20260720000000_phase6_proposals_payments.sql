-- Phase 6: proposal composer config, frozen send-time snapshot, deposit config,
-- decline tracking, and Stripe Connect account state on companies.

alter table public.proposals
  -- Composer settings, editable while draft (cover photo, intro, inclusions,
  -- exclusions, deposit config, validity days). Never edited after send.
  add column if not exists config jsonb not null default '{}'::jsonb,
  -- The frozen render model captured at send time. content_hash is computed
  -- over this. Immutable once set.
  add column if not exists snapshot jsonb,
  add column if not exists declined_at timestamptz,
  add column if not exists decline_reason text,
  add column if not exists expires_at timestamptz;

-- The deposit invoice a signed proposal generates (§Phase 6.6).
alter table public.invoices
  add column if not exists proposal_id uuid references public.proposals(id) on delete set null,
  add column if not exists stripe_checkout_session_id text,
  add column if not exists application_fee numeric,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists public_token text unique;

-- Stripe Connect Express account state lives on the company settings jsonb, but
-- we denormalize the account id + charges-enabled flag for fast gating.
alter table public.companies
  add column if not exists stripe_account_id text,
  add column if not exists stripe_charges_enabled boolean not null default false;

-- Idempotency ledger for webhook events (§Phase 6 acceptance: replays are
-- idempotent). Every processed provider event id is recorded once.
create table if not exists public.webhook_events (
  id            text primary key,          -- provider event id (e.g. Stripe evt_...)
  provider      text not null default 'stripe',
  type          text not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
