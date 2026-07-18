import uuid

from fastapi.testclient import TestClient

from fieldquote.core.auth import Hs256Verifier
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
