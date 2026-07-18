"""/me contract test with the tenancy dependency faked (real path covered by RLS/DB tests)."""

import uuid
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fieldquote.core.tenancy import TenantContext, get_current_context
from fieldquote.domain.models import Company, User

COMPANY_ID = uuid.uuid4()
USER_ID = uuid.uuid4()


def fake_context() -> TenantContext:
    company = Company(
        id=COMPANY_ID, name="Reel Electric", trade="electrical", timezone="America/Los_Angeles"
    )
    user = User(id=USER_ID, company_id=COMPANY_ID, role="owner", name="Will")
    return TenantContext(user=user, company=company)


@pytest.fixture
def authed_client(app: FastAPI) -> Iterator[TestClient]:
    app.dependency_overrides[get_current_context] = fake_context
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_current_context)


def test_me_returns_user_and_company(authed_client: TestClient) -> None:
    res = authed_client.get("/me")
    assert res.status_code == 200
    body = res.json()
    assert body["id"] == str(USER_ID)
    assert body["role"] == "owner"
    assert body["company"]["id"] == str(COMPANY_ID)
    assert body["company"]["name"] == "Reel Electric"
