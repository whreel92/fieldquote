"""Phase 1 CRUD integration tests against live Postgres (marker: db).

Real DB, real tenancy (auto-provision) — only JWT verification is bypassed by
overriding get_auth. Run via scripts/test_rls.sh or CI's postgres service.
"""

import os
import uuid
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

pytestmark = pytest.mark.db

DB_URL = os.environ.get("FQ_RLS_DB_URL", "")
if not DB_URL:
    pytest.skip("FQ_RLS_DB_URL not set (use scripts/test_rls.sh)", allow_module_level=True)

from fieldquote.core.auth import AuthContext, get_auth  # noqa: E402
from fieldquote.core.db import get_db  # noqa: E402
from fieldquote.domain.models import AuditLog  # noqa: E402
from fieldquote.integrations.storage import FakeStorage, get_storage  # noqa: E402
from fieldquote.main import create_app  # noqa: E402

USER_1 = str(uuid.uuid4())
USER_2 = str(uuid.uuid4())
_current_user: dict[str, str] = {"id": USER_1}


@pytest.fixture(scope="module")
def app() -> Iterator[FastAPI]:
    os.environ["DATABASE_URL"] = DB_URL
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config("alembic.ini"), "head")

    engine = create_engine(DB_URL)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    def override_db() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    application = create_app()
    application.dependency_overrides[get_db] = override_db
    application.dependency_overrides[get_auth] = lambda: AuthContext(
        user_id=_current_user["id"], email="phase1@test.dev"
    )
    application.dependency_overrides[get_storage] = FakeStorage
    yield application
    engine.dispose()


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    _current_user["id"] = USER_1
    with TestClient(app) as c:
        yield c


def as_user(client: TestClient, user_id: str) -> TestClient:
    _current_user["id"] = user_id
    return client


@pytest.fixture(scope="module")
def db() -> Iterator[Session]:
    engine = create_engine(DB_URL)
    with Session(engine) as session:
        yield session
    engine.dispose()


# ── company & rates ──────────────────────────────────────────────────────────


def test_company_get_and_patch(client: TestClient) -> None:
    company = client.get("/company").json()
    assert company["name"] == "phase1@test.dev"  # auto-provisioned

    res = client.patch(
        "/company",
        json={"name": "Reel Electric", "license_number": "AZ-ROC-12345", "phone": "480-555-0100"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["name"] == "Reel Electric"
    assert body["license_number"] == "AZ-ROC-12345"


def test_rates_default_then_confirm(client: TestClient) -> None:
    rates = client.get("/company/rates").json()
    assert rates["confirmed"] is False
    assert float(rates["labor_rate"]) == 125.0  # safe default

    res = client.put(
        "/company/rates",
        json={
            "labor_rate": "145",
            "helper_rate": "70",
            "target_margin_pct": "50",
            "tax_rate_pct": "8.1",
            "markup_model": "margin",
            "confirmed": True,
        },
    )
    assert res.status_code == 200

    rates = client.get("/company/rates").json()
    assert float(rates["labor_rate"]) == 145.0
    assert rates["confirmed"] is True


def test_rates_validation(client: TestClient) -> None:
    res = client.put(
        "/company/rates",
        json={
            "labor_rate": "145",
            "target_margin_pct": "100",  # >= 100% margin is nonsense
            "tax_rate_pct": "0",
            "markup_model": "margin",
        },
    )
    assert res.status_code == 422


def test_logo_upload_url(client: TestClient) -> None:
    res = client.post("/company/logo-upload-url")
    assert res.status_code == 200
    assert res.json()["upload_url"].startswith("fake://documents/")


# ── clients ──────────────────────────────────────────────────────────────────


def test_client_crud_and_search(client: TestClient) -> None:
    created = client.post(
        "/clients", json={"name": "Sarah Chen", "phone": "480-555-0101", "email": "sarah@x.co"}
    )
    assert created.status_code == 201
    cid = created.json()["id"]
    client.post("/clients", json={"name": "Bob Martinez"})

    assert len(client.get("/clients").json()) >= 2
    hits = client.get("/clients", params={"search": "sara"}).json()
    assert [h["name"] for h in hits] == ["Sarah Chen"]
    hits = client.get("/clients", params={"search": "0101"}).json()
    assert [h["name"] for h in hits] == ["Sarah Chen"]

    res = client.patch(f"/clients/{cid}", json={"notes": "prefers text"})
    assert res.json()["notes"] == "prefers text"

    assert client.delete(f"/clients/{cid}").status_code == 204
    assert client.get(f"/clients/{cid}").status_code == 404


def test_client_cross_tenant_invisible(client: TestClient) -> None:
    created = client.post("/clients", json={"name": "Tenant One Secret"})
    cid = created.json()["id"]

    other = as_user(client, USER_2)
    assert other.get(f"/clients/{cid}").status_code == 404
    assert other.patch(f"/clients/{cid}", json={"name": "stolen"}).status_code == 404
    names = [c["name"] for c in other.get("/clients").json()]
    assert "Tenant One Secret" not in names


# ── jobs ─────────────────────────────────────────────────────────────────────


def test_job_lifecycle_and_guards(client: TestClient, db: Session) -> None:
    cid = client.post("/clients", json={"name": "Job Client"}).json()["id"]
    created = client.post(
        "/jobs",
        json={"title": "200A panel swap", "client_id": cid, "job_type_code": "panel_upgrade"},
    )
    assert created.status_code == 201
    job = created.json()
    assert job["status"] == "lead"
    assert job["client_name"] == "Job Client"
    assert job["allowed_transitions"] == ["estimating", "lost"]
    jid = job["id"]

    for target in ("estimating", "sent", "won"):
        res = client.post(f"/jobs/{jid}/transition", json={"to_status": target})
        assert res.status_code == 200, res.text
        assert res.json()["status"] == target

    # Guard: won -> paid skips steps
    res = client.post(f"/jobs/{jid}/transition", json={"to_status": "paid"})
    assert res.status_code == 409
    body = res.json()["error"]
    assert body["code"] == "conflict"
    assert body["details"]["allowed"] == ["in_progress", "lost"]

    # Unknown status
    res = client.post(f"/jobs/{jid}/transition", json={"to_status": "banana"})
    assert res.status_code == 409

    # Every successful transition audit-logged
    rows = db.scalars(
        select(AuditLog).where(
            AuditLog.entity == "job",
            AuditLog.entity_id == uuid.UUID(jid),
            AuditLog.action == "status_transition",
        )
    ).all()
    assert len(rows) == 3
    assert [r.after for r in rows if r.after] == [
        {"status": "estimating"},
        {"status": "sent"},
        {"status": "won"},
    ]


def test_job_list_filter_and_cross_tenant(client: TestClient) -> None:
    client.post("/jobs", json={"title": "Fan install", "job_type_code": "fixtures_fans"})
    leads = client.get("/jobs", params={"status": "lead"}).json()
    assert all(j["status"] == "lead" for j in leads)
    assert any(j["title"] == "Fan install" for j in leads)

    jid = leads[0]["id"]
    other = as_user(client, USER_2)
    assert other.get(f"/jobs/{jid}").status_code == 404
    res = other.post(f"/jobs/{jid}/transition", json={"to_status": "estimating"})
    assert res.status_code == 404


def test_job_rejects_foreign_client(client: TestClient) -> None:
    foreign_cid = as_user(client, USER_2).post("/clients", json={"name": "Other Co"}).json()["id"]
    res = as_user(client, USER_1).post(
        "/jobs", json={"title": "Sneaky", "client_id": foreign_cid}
    )
    assert res.status_code == 404
