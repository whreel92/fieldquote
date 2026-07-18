# ADR-0003: Every tenant table carries company_id, including child tables

Date: 2026-07-18 · Status: accepted

## Context

CLAUDE.md §0.1.6 (non-negotiable): "Every table with tenant data carries `company_id`." The
Phase 0 schema listing omits it on child tables (captures, estimate_lines, signatures,
payments, followup_events), which would force RLS policies to join through parents.

## Decision

Add a denormalized `company_id uuid not null references companies` to every tenant child table.
One uniform RLS policy (`company_id = current_company_id()`) covers all 17 tenant tables; the
API sets `company_id` from the resolved tenant context on insert.

## Consequences

- RLS is simple, uniform, and index-backed (`*_company_idx` on every table).
- The API must always populate `company_id` on child inserts — service-layer helpers will do
  this; a mismatch between child and parent would be a bug (consider a trigger check if it ever
  bites).
