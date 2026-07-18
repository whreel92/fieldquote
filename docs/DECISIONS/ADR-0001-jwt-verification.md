# ADR-0001: Supabase JWT verification — HS256 first, JWKS behind the same interface

Date: 2026-07-18 · Status: accepted

## Context

The API must verify Supabase Auth access tokens. Supabase supports the legacy shared HS256
secret and newer asymmetric keys discovered via JWKS.

## Decision

Phase 0 ships `Hs256Verifier` (PyJWT + `SUPABASE_JWT_SECRET`, audience `authenticated`). All
call sites depend on the `TokenVerifier` protocol, so a `JwksVerifier` (httpx + cached keys) can
replace it without touching routers.

## Consequences

- Local/self-hosted Supabase works immediately; zero network calls on the hot path.
- Debt FQ-D001: implement + test `JwksVerifier` before staging if the hosted project uses
  asymmetric signing keys.
