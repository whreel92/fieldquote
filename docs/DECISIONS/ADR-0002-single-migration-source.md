# ADR-0002: One canonical SQL file per migration, applied by both Supabase CLI and Alembic

Date: 2026-07-18 · Status: accepted

## Context

The spec calls for both Supabase config-as-code (`infra/supabase/`) and Alembic
(`apps/api/migrations/`). Two schema sources would inevitably drift.

## Decision

Schema SQL lives once in `infra/supabase/migrations/<timestamp>_<name>.sql` (Supabase CLI
format). Each Alembic revision is a thin wrapper that `op.execute()`s the corresponding file.
Alembic remains the tool the API/CI use (`alembic upgrade head`, offline `--sql` mode works);
the Supabase CLI applies the identical files to hosted projects.

## Consequences

- No drift by construction; RLS tests exercise the exact SQL production runs.
- Alembic autogenerate is off; SQLAlchemy models are hand-maintained for tables the API touches.
- The SQL includes guarded creation of `auth.uid()` / role `authenticated` so plain Postgres
  (tests) behaves like Supabase; on Supabase these are no-ops.
