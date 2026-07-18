# ADR-0004: First authenticated request auto-provisions company + owner user

Date: 2026-07-18 · Status: accepted

## Context

Phase 0's verification is "sign up on mobile, hit GET /me → returns user + company". Supabase
owns signup; the API needs a `users` row linking the auth uid to a company.

## Decision

`get_current_context` creates a Company + owner User on first sight of a verified, unknown auth
uid (idempotent). Phase 1's onboarding wizard then fills in real company details.

## Consequences

- No separate bootstrap endpoint; mobile flow is one round-trip.
- Team invites (Phase 8) must attach invited uids to the inviter's company BEFORE their first
  /me call, or they'd get a fresh company. The invite-acceptance flow must handle this —
  flagged in the Phase 8 spec notes.
