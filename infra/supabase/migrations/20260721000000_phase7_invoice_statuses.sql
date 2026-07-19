-- Phase 7: invoice lifecycle statuses.
-- Partial payments and refunds are first-class now: 'partial' replaces the
-- never-used 'partially_paid', and 'refunded' is the terminal state when
-- everything collected has been returned.

alter table public.invoices
  drop constraint if exists invoices_status_check;

alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft', 'sent', 'partial', 'paid', 'overdue', 'refunded', 'void'));
