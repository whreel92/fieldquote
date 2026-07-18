-- FieldQuote core schema (Phase 0).
-- Canonical source of truth. Applied by Supabase CLI and by Alembic (which
-- reads this file). Extend in later migrations; never rename casually.
--
-- Tenancy rule (CLAUDE.md §0.1.6): every tenant table carries company_id and
-- has RLS enforcing isolation. Child tables carry a denormalized company_id
-- so policies never join. Service-role/API access bypasses RLS and must
-- tenant-scope in code.

-- ── auth stub (no-op on Supabase, needed for plain-Postgres test runs) ──────
create schema if not exists auth;
do $$
begin
  if not exists (
    select from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    create function auth.uid() returns uuid
    language sql stable
    as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
  end if;
end
$$;

-- Role `authenticated` exists on Supabase; create for plain-Postgres tests.
do $$
begin
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

-- ── companies & users ───────────────────────────────────────────────────────
create table public.companies (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  trade           text not null default 'electrical',
  logo_url        text,
  license_number  text,
  insurance_line  text,
  phone           text,
  email           text,
  address         text,
  timezone        text not null default 'America/Los_Angeles',
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create table public.users (
  id          uuid primary key,  -- ↔ supabase auth uid
  company_id  uuid not null references public.companies(id) on delete cascade,
  role        text not null default 'owner'
              check (role in ('owner', 'admin', 'tech', 'office')),
  name        text,
  phone       text,
  created_at  timestamptz not null default now()
);
create index users_company_idx on public.users (company_id);

-- Tenant helper (defined after users so the body validates at creation time).
create or replace function public.current_company_id() returns uuid
language sql stable security definer
set search_path = public
as $$ select company_id from public.users where id = auth.uid() $$;

-- ── clients & jobs ──────────────────────────────────────────────────────────
create table public.clients (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  name        text not null,
  phone       text,
  email       text,
  address     text,
  notes       text,
  created_at  timestamptz not null default now()
);
create index clients_company_idx on public.clients (company_id);

create table public.jobs (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  client_id      uuid references public.clients(id) on delete set null,
  title          text not null,
  status         text not null default 'lead'
                 check (status in ('lead', 'estimating', 'sent', 'won', 'lost',
                                   'in_progress', 'complete', 'paid')),
  job_type_code  text,
  address        text,
  created_by     uuid references public.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index jobs_company_idx on public.jobs (company_id);
create index jobs_client_idx on public.jobs (client_id);

-- ── captures ────────────────────────────────────────────────────────────────
create table public.captures (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  job_id           uuid not null references public.jobs(id) on delete cascade,
  kind             text not null check (kind in ('photo', 'audio')),
  storage_path     text not null,
  duration_s       numeric,
  exif             jsonb,
  transcript       text,
  vision_findings  jsonb,
  upload_state     text not null default 'pending'
                   check (upload_state in ('pending', 'uploading', 'uploaded', 'failed')),
  created_at       timestamptz not null default now()
);
create index captures_company_idx on public.captures (company_id);
create index captures_job_idx on public.captures (job_id);

-- ── estimates ───────────────────────────────────────────────────────────────
create table public.estimates (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  job_id       uuid not null references public.jobs(id) on delete cascade,
  version      integer not null default 1,
  status       text not null default 'draft'
               check (status in ('draft', 'approved', 'superseded', 'generation_failed')),
  source       text not null default 'ai' check (source in ('ai', 'manual', 'duplicate')),
  scope_prose  text,
  ai_output    jsonb,
  totals       jsonb,
  approved_by  uuid references public.users(id) on delete set null,
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (job_id, version)
);
create index estimates_company_idx on public.estimates (company_id);
create index estimates_job_idx on public.estimates (job_id);

create table public.estimate_lines (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  estimate_id    uuid not null references public.estimates(id) on delete cascade,
  position       integer not null,
  assembly_code  text,
  description    text not null,
  qty            numeric not null default 1,
  unit           text,
  material_cost  numeric,
  labor_hours    numeric,
  labor_rate     numeric,
  line_type      text not null default 'standard'
                 check (line_type in ('standard', 'allowance', 'verify', 'option_good',
                                      'option_better', 'option_best', 'discount')),
  price_source   text not null default 'engine'
                 check (price_source in ('engine', 'manual', 'pricebook')),
  confidence     text not null default 'known'
                 check (confidence in ('known', 'allowance', 'verify')),
  editable_note  text,
  totals         jsonb
);
create index estimate_lines_company_idx on public.estimate_lines (company_id);
create index estimate_lines_estimate_idx on public.estimate_lines (estimate_id);

-- ── proposals & signatures ──────────────────────────────────────────────────
create table public.proposals (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  estimate_id         uuid not null references public.estimates(id) on delete cascade,
  version             integer not null default 1,
  public_token        text not null unique,
  status              text not null default 'draft'
                      check (status in ('draft', 'sent', 'viewed', 'signed',
                                        'declined', 'expired')),
  pdf_path            text,
  html_snapshot_path  text,
  content_hash        text,
  terms_version       text,
  sent_at             timestamptz,
  first_viewed_at     timestamptz,
  view_count          integer not null default 0
);
create index proposals_company_idx on public.proposals (company_id);
create index proposals_estimate_idx on public.proposals (estimate_id);

create table public.signatures (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  proposal_id     uuid not null references public.proposals(id) on delete cascade,
  signer_name     text not null,
  signer_email    text,
  ip              text,
  user_agent      text,
  signed_at       timestamptz not null default now(),
  signature_hash  text not null
);
create index signatures_company_idx on public.signatures (company_id);
create index signatures_proposal_idx on public.signatures (proposal_id);

-- ── invoices & payments ─────────────────────────────────────────────────────
create table public.invoices (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references public.companies(id) on delete cascade,
  job_id                    uuid not null references public.jobs(id) on delete cascade,
  kind                      text not null check (kind in ('deposit', 'progress', 'final')),
  number                    text not null,
  status                    text not null default 'draft'
                            check (status in ('draft', 'sent', 'partially_paid', 'paid',
                                              'overdue', 'void')),
  line_items                jsonb not null default '[]'::jsonb,
  subtotal                  numeric not null default 0,
  tax                       numeric not null default 0,
  total                     numeric not null default 0,
  due_at                    timestamptz,
  stripe_payment_intent_id  text,
  pdf_path                  text,
  sent_at                   timestamptz,
  paid_at                   timestamptz,
  unique (company_id, number)
);
create index invoices_company_idx on public.invoices (company_id);
create index invoices_job_idx on public.invoices (job_id);

create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  provider    text not null default 'stripe' check (provider in ('stripe')),
  amount      numeric not null,
  fee         numeric,
  net         numeric,
  status      text not null,
  raw         jsonb,
  created_at  timestamptz not null default now()
);
create index payments_company_idx on public.payments (company_id);
create index payments_invoice_idx on public.payments (invoice_id);

-- ── follow-ups ──────────────────────────────────────────────────────────────
create table public.followup_sequences (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  trigger     text not null
              check (trigger in ('proposal_unopened_24h', 'proposal_viewed_not_signed_48h',
                                 'signed_no_deposit_24h', 'invoice_overdue_3d',
                                 'job_complete_review')),
  steps       jsonb not null default '[]'::jsonb,
  enabled     boolean not null default true
);
create index followup_sequences_company_idx on public.followup_sequences (company_id);

create table public.followup_events (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  job_id        uuid not null references public.jobs(id) on delete cascade,
  sequence_id   uuid not null references public.followup_sequences(id) on delete cascade,
  step_index    integer not null,
  channel       text not null check (channel in ('sms', 'email')),
  scheduled_at  timestamptz not null,
  sent_at       timestamptz,
  status        text not null default 'scheduled'
                check (status in ('scheduled', 'sent', 'skipped', 'stopped', 'failed')),
  error         text
);
create index followup_events_company_idx on public.followup_events (company_id);
create index followup_events_job_idx on public.followup_events (job_id);

-- ── job actuals & audit ─────────────────────────────────────────────────────
create table public.job_actuals (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete cascade,
  job_id              uuid not null references public.jobs(id) on delete cascade,
  kind                text not null check (kind in ('receipt', 'time')),
  amount              numeric,
  hours               numeric,
  description         text,
  receipt_photo_path  text,
  ocr                 jsonb,
  created_by          uuid references public.users(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index job_actuals_company_idx on public.job_actuals (company_id);
create index job_actuals_job_idx on public.job_actuals (job_id);

create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  actor_id    uuid references public.users(id) on delete set null,
  entity      text not null,
  entity_id   uuid,
  action      text not null,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_company_idx on public.audit_log (company_id);

-- ── company rates & subscriptions ───────────────────────────────────────────
create table public.company_rates (
  company_id         uuid primary key references public.companies(id) on delete cascade,
  labor_rate         numeric not null default 0,
  helper_rate        numeric,
  target_margin_pct  numeric not null default 0,
  tax_rate_pct       numeric not null default 0,
  markup_model       text not null default 'margin' check (markup_model in ('margin', 'markup')),
  overrides          jsonb not null default '{}'::jsonb
);

create table public.subscriptions (
  company_id          uuid primary key references public.companies(id) on delete cascade,
  tier                text not null default 'trial'
                      check (tier in ('trial', 'solo', 'pro', 'team')),
  seats               integer not null default 1,
  source              text check (source in ('stripe', 'revenuecat')),
  status              text not null default 'trialing',
  current_period_end  timestamptz,
  entitlements        jsonb not null default '{}'::jsonb
);

-- ── global pricing data (not tenant-scoped; read-only to tenants) ───────────
create table public.material_items (
  sku                 text primary key,
  description         text not null,
  unit                text not null,
  category            text,
  base_price          numeric not null,
  price_asof          date,
  source              text,
  region_multipliers  jsonb not null default '{}'::jsonb
);

create table public.assemblies (
  code              text primary key,
  trade             text not null default 'electrical',
  name              text not null,
  description       text,
  job_type_codes    text[] not null default '{}',
  labor_hours       numeric not null,
  labor_notes       text,
  bom               jsonb not null default '[]'::jsonb,
  modifiers_allowed text[] not null default '{}',
  version           integer not null default 1,
  status            text not null default 'draft' check (status in ('draft', 'advisor_approved'))
);

create table public.modifiers (
  code         text primary key,
  name         text not null,
  description  text,
  effect       jsonb not null,
  version      integer not null default 1
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Default grants comparable to Supabase's.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

alter table public.companies enable row level security;
create policy companies_tenant on public.companies for all to authenticated
  using (id = public.current_company_id())
  with check (id = public.current_company_id());

alter table public.users enable row level security;
create policy users_tenant on public.users for all to authenticated
  using (id = auth.uid() or company_id = public.current_company_id())
  with check (company_id = public.current_company_id());

-- Uniform tenant policy for every table keyed by company_id.
do $$
declare
  t text;
begin
  foreach t in array array[
    'clients', 'jobs', 'captures', 'estimates', 'estimate_lines', 'proposals',
    'signatures', 'invoices', 'payments', 'followup_sequences', 'followup_events',
    'job_actuals', 'audit_log', 'company_rates', 'subscriptions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (company_id = public.current_company_id())
         with check (company_id = public.current_company_id())',
      t || '_tenant', t
    );
  end loop;
end
$$;

-- Global pricing data: authenticated may read, never write (service role only).
alter table public.material_items enable row level security;
alter table public.assemblies enable row level security;
alter table public.modifiers enable row level security;
create policy material_items_read on public.material_items for select to authenticated using (true);
create policy assemblies_read on public.assemblies for select to authenticated using (true);
create policy modifiers_read on public.modifiers for select to authenticated using (true);
revoke insert, update, delete on public.material_items, public.assemblies, public.modifiers
  from authenticated;
