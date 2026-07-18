-- Phase 2: fields the pricing engine needs on the assembly catalog.
-- unit          - pricing/display unit ("ea", "ft", "opening", ...)
-- helper_hours  - helper-rate labor split (engine rule 4, ADR-0005)
-- option_tiers  - good/better/best variants: [{tier,label,labor_hours,helper_hours,bom}]

alter table public.assemblies
  add column if not exists unit text not null default 'ea',
  add column if not exists helper_hours numeric not null default 0,
  add column if not exists option_tiers jsonb;
