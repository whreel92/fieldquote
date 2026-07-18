import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from fieldquote.core.auth import Hs256Verifier, JwksVerifier, SupabaseVerifier
from fieldquote.core.errors import UnauthorizedError
from tests.conftest import TEST_SECRET, make_token


def test_missing_token_is_401_with_envelope(client: TestClient) -> None:
    res = client.get("/me")
    assert res.status_code == 401
    body = res.json()
    assert body["error"]["code"] == "unauthorized"
    assert "message" in body["error"]


def test_malformed_header_is_401(client: TestClient) -> None:
    res = client.get("/me", headers={"Authorization": "Token abc"})
    assert res.status_code == 401


def test_expired_token_is_401(client: TestClient) -> None:
    token = make_token(expires_in=-60)
    res = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "unauthorized"


def test_wrong_secret_is_401(client: TestClient) -> None:
    token = make_token(secret="the-wrong-secret-entirely-000000")
    res = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401


def test_wrong_audience_is_401(client: TestClient) -> None:
    token = make_token(audience="anon")
    res = client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 401


def test_verifier_extracts_claims() -> None:
    uid = str(uuid.uuid4())
    ctx = Hs256Verifier(TEST_SECRET).verify(make_token(user_id=uid, email="a@b.co"))
    assert ctx.user_id == uid
    assert ctx.email == "a@b.co"


# ── ES256 / JWKS path (hosted Supabase signs asymmetrically) ─────────────────

_EC_KEY = ec.generate_private_key(ec.SECP256R1())


class _FakeSigningKey:
    key = _EC_KEY.public_key()


class _FakeJwksClient:
    def get_signing_key_from_jwt(self, token: str) -> _FakeSigningKey:
        return _FakeSigningKey()


def make_es256_token(user_id: str, expires_in: int = 3600, audience: str = "authenticated") -> str:
    now = datetime.now(tz=UTC)
    return jwt.encode(
        {
            "sub": user_id,
            "email": "es@b.co",
            "aud": audience,
            "iat": now,
            "exp": now + timedelta(seconds=expires_in),
        },
        _EC_KEY,
        algorithm="ES256",
        headers={"kid": "test-kid"},
    )


def _jwks_verifier() -> JwksVerifier:
    v = JwksVerifier("https://example.supabase.co")
    v._client = _FakeJwksClient()  # type: ignore[assignment]
    return v


def test_jwks_verifier_accepts_es256() -> None:
    uid = str(uuid.uuid4())
    ctx = _jwks_verifier().verify(make_es256_token(uid))
    assert ctx.user_id == uid
    assert ctx.email == "es@b.co"


def test_jwks_verifier_rejects_expired() -> None:
    with pytest.raises(UnauthorizedError):
        _jwks_verifier().verify(make_es256_token(str(uuid.uuid4()), expires_in=-60))


def test_jwks_verifier_rejects_wrong_audience() -> None:
    with pytest.raises(UnauthorizedError):
        _jwks_verifier().verify(make_es256_token(str(uuid.uuid4()), audience="anon"))


def test_supabase_verifier_routes_by_alg() -> None:
    v = SupabaseVerifier(TEST_SECRET, "https://example.supabase.co")
    v._jwks._client = _FakeJwksClient()  # type: ignore[union-attr]
    uid = str(uuid.uuid4())
    assert v.verify(make_token(user_id=uid)).user_id == uid  # HS256 path
    assert v.verify(make_es256_token(uid)).user_id == uid  # ES256 path
    with pytest.raises(UnauthorizedError):
        v.verify("not-a-jwt")


def test_supabase_verifier_rejects_unroutable_alg() -> None:
    v = SupabaseVerifier(TEST_SECRET, "")  # no JWKS configured
    with pytest.raises(UnauthorizedError):
        v.verify(make_es256_token(str(uuid.uuid4())))
