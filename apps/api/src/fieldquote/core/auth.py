"""Supabase JWT verification (ADR-0001).

Hosted Supabase signs access tokens with asymmetric keys (ES256 + JWKS
discovery); local/self-hosted stacks use the shared HS256 secret. The
`SupabaseVerifier` routes on the token header's `alg`, so both work, and both
paths are wrapped so callers only ever see `UnauthorizedError`.
"""

import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated, Any, Protocol

import jwt
from fastapi import Depends, Request

from fieldquote.core.config import get_settings
from fieldquote.core.errors import UnauthorizedError

logger = logging.getLogger(__name__)

AUDIENCE = "authenticated"
_ASYMMETRIC_ALGS = ("ES256", "RS256")


@dataclass(frozen=True)
class AuthContext:
    """Verified identity claims from a Supabase access token."""

    user_id: str
    email: str | None


class TokenVerifier(Protocol):
    def verify(self, token: str) -> AuthContext: ...


def _context_from_claims(claims: dict[str, Any]) -> AuthContext:
    email = claims.get("email")
    return AuthContext(
        user_id=str(claims["sub"]),
        email=str(email) if email is not None else None,
    )


class Hs256Verifier:
    """Shared-secret verification (local dev, self-hosted, tests)."""

    def __init__(self, secret: str, audience: str = AUDIENCE) -> None:
        if not secret:
            raise ValueError("SUPABASE_JWT_SECRET is required for HS256 verification")
        self._secret = secret
        self._audience = audience

    def verify(self, token: str) -> AuthContext:
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                self._secret,
                algorithms=["HS256"],
                audience=self._audience,
                options={"require": ["exp", "sub"]},
            )
        except jwt.PyJWTError as exc:
            raise UnauthorizedError("Your session is invalid or expired.") from exc
        return _context_from_claims(claims)


class JwksVerifier:
    """Asymmetric verification via the project's JWKS endpoint (hosted Supabase)."""

    def __init__(self, supabase_url: str, audience: str = AUDIENCE) -> None:
        if not supabase_url:
            raise ValueError("SUPABASE_URL is required for JWKS verification")
        self._client = jwt.PyJWKClient(
            f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json",
            cache_keys=True,
            lifespan=300,
        )
        self._audience = audience

    def verify(self, token: str) -> AuthContext:
        try:
            key = self._client.get_signing_key_from_jwt(token).key
            claims: dict[str, Any] = jwt.decode(
                token,
                key,
                algorithms=list(_ASYMMETRIC_ALGS),
                audience=self._audience,
                options={"require": ["exp", "sub"]},
            )
        except jwt.PyJWKClientError as exc:
            logger.error("jwks_fetch_failed", extra={"error": str(exc)})
            raise UnauthorizedError("We couldn't verify your session. Try again.") from exc
        except jwt.PyJWTError as exc:
            raise UnauthorizedError("Your session is invalid or expired.") from exc
        return _context_from_claims(claims)


class SupabaseVerifier:
    """Routes on the token's `alg` header: HS256 → secret, ES256/RS256 → JWKS."""

    def __init__(self, jwt_secret: str, supabase_url: str) -> None:
        self._hs256 = Hs256Verifier(jwt_secret) if jwt_secret else None
        self._jwks = JwksVerifier(supabase_url) if supabase_url else None
        if self._hs256 is None and self._jwks is None:
            raise ValueError("Set SUPABASE_JWT_SECRET and/or SUPABASE_URL to verify tokens")

    def verify(self, token: str) -> AuthContext:
        try:
            alg = jwt.get_unverified_header(token).get("alg")
        except jwt.PyJWTError as exc:
            raise UnauthorizedError("Your session is invalid or expired.") from exc
        if alg == "HS256" and self._hs256 is not None:
            return self._hs256.verify(token)
        if alg in _ASYMMETRIC_ALGS and self._jwks is not None:
            return self._jwks.verify(token)
        raise UnauthorizedError("Your session is invalid or expired.")


@lru_cache
def _cached_verifier(jwt_secret: str, supabase_url: str) -> SupabaseVerifier:
    # Cached so the JWKS key cache survives across requests.
    return SupabaseVerifier(jwt_secret, supabase_url)


def get_verifier() -> TokenVerifier:
    settings = get_settings()
    return _cached_verifier(settings.supabase_jwt_secret, settings.supabase_url)


def get_auth(
    request: Request,
    verifier: Annotated[TokenVerifier, Depends(get_verifier)],
) -> AuthContext:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise UnauthorizedError("Sign in to continue.")
    return verifier.verify(token)
