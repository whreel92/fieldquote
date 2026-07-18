"""Supabase JWT verification.

Phase 0 verifies HS256 tokens against SUPABASE_JWT_SECRET (the "legacy" Supabase
JWT secret, still the default for self-hosted/local stacks). Asymmetric JWKS
verification slots in behind the same `TokenVerifier` protocol (debt: FQ-D001).
"""

from dataclasses import dataclass
from typing import Annotated, Any, Protocol

import jwt
from fastapi import Depends, Request

from fieldquote.core.config import Settings, get_settings
from fieldquote.core.errors import UnauthorizedError


@dataclass(frozen=True)
class AuthContext:
    """Verified identity claims from a Supabase access token."""

    user_id: str
    email: str | None


class TokenVerifier(Protocol):
    def verify(self, token: str) -> AuthContext: ...


class Hs256Verifier:
    def __init__(self, secret: str, audience: str = "authenticated") -> None:
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
        email = claims.get("email")
        return AuthContext(
            user_id=str(claims["sub"]),
            email=str(email) if email is not None else None,
        )


def get_verifier(settings: Annotated[Settings, Depends(get_settings)]) -> TokenVerifier:
    return Hs256Verifier(settings.supabase_jwt_secret)


def get_auth(
    request: Request,
    verifier: Annotated[TokenVerifier, Depends(get_verifier)],
) -> AuthContext:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise UnauthorizedError("Sign in to continue.")
    return verifier.verify(token)
