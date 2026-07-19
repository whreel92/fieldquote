"""RED-TEAM suite for the approval flow — the legal control (§0.1.2, §Phase 5.7).

Attacks the API directly and proves there is no code path from a draft
estimate to anything sendable: proposals refuse drafts, approval demands
every section confirmation and an authorized role, approved estimates are
immutable (mutations 409 → fork), and forks version correctly."""

import os
import uuid
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

pytestmark = pytest.mark.db

DB_URL = os.environ.get("FQ_RLS_DB_URL", "")
if not DB_URL:
    pytest.skip("FQ_RLS_DB_URL not set (use scripts/test_rls.sh)", allow_module_level=True)

from fieldquote.core.auth import AuthContext, get_auth  # noqa: E402
from fieldquote.core.db import get_db  # noqa: E402
from fieldquote.domain.models import User  # noqa: E402
from fieldquote.main import create_app  # noqa: E402

OWNER = str(uuid.uuid4())
TECH = str(uuid.uuid4())
_current_user: dict[str, str] = {"id": OWNER}

ALL_CONFIRMATIONS = {"scope": True, "lines": True, "totals": True, "terms": True}


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
        user_id=_current_user["id"], email="phase5@test.dev"
    )
    yield application
    engine.dispose()


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    _current_user["id"] = OWNER
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def db() -> Iterator[Session]:
    engine = create_engine(DB_URL)
    with Session(engine) as session:
        yield session
    engine.dispose()


def _draft_estimate(client: TestClient) -> tuple[str, str]:
    job_id = client.post("/jobs", json={"title": "Approval test"}).json()["id"]
    estimate = client.post(
        f"/jobs/{job_id}/estimates", json={"scope_prose": "Manual scope."}
    ).json()
    client.post(
        f"/estimates/{estimate['id']}/lines",
        json={"description": "Manual line", "unit_price": "500", "qty": 1},
    )
    return job_id, estimate["id"]


# ── the control itself ───────────────────────────────────────────────────────


def test_draft_estimate_cannot_become_proposal(client: TestClient) -> None:
    _, estimate_id = _draft_estimate(client)
    res = client.post(f"/estimates/{estimate_id}/proposals")
    assert res.status_code == 409
    assert res.json()["error"]["details"]["code"] == "approval_required"


def test_generation_failed_estimate_cannot_become_proposal(client: TestClient, db: Session) -> None:
    from fieldquote.domain.models import Estimate

    _, estimate_id = _draft_estimate(client)
    row = db.get(Estimate, uuid.UUID(estimate_id))
    assert row is not None
    row.status = "generation_failed"
    db.commit()
    res = client.post(f"/estimates/{estimate_id}/proposals")
    assert res.status_code == 409


def test_approval_requires_every_section(client: TestClient) -> None:
    _, estimate_id = _draft_estimate(client)
    for missing in ("scope", "lines", "totals", "terms"):
        confirmations = {**ALL_CONFIRMATIONS, missing: False}
        res = client.post(
            f"/estimates/{estimate_id}/approve", json={"confirmations": confirmations}
        )
        assert res.status_code == 409
        assert missing in res.json()["error"]["details"]["missing_confirmations"]

    # empty payload also fails
    res = client.post(f"/estimates/{estimate_id}/approve", json={"confirmations": {}})
    assert res.status_code == 409


def test_tech_role_cannot_approve(client: TestClient, db: Session) -> None:
    _, estimate_id = _draft_estimate(client)
    _current_user["id"] = TECH
    client.get("/me")  # auto-provision, then downgrade
    tech = db.get(User, uuid.UUID(TECH))
    assert tech is not None
    tech.role = "tech"
    # tech joins the owner's company for this check? No — tech has own company,
    # so the estimate 404s for them; role gate must ALSO hold within a company.
    # Move tech into the owner's company to isolate the role check:
    owner = db.get(User, uuid.UUID(OWNER))
    assert owner is not None
    tech.company_id = owner.company_id
    db.commit()
    res = client.post(
        f"/estimates/{estimate_id}/approve", json={"confirmations": ALL_CONFIRMATIONS}
    )
    assert res.status_code == 403
    _current_user["id"] = OWNER


def test_approve_then_proposal_succeeds_and_records_approver(
    client: TestClient, db: Session
) -> None:
    _, estimate_id = _draft_estimate(client)
    res = client.post(
        f"/estimates/{estimate_id}/approve", json={"confirmations": ALL_CONFIRMATIONS}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "approved"

    from fieldquote.domain.models import Estimate

    row = db.get(Estimate, uuid.UUID(estimate_id))
    assert row is not None
    assert row.approved_by == uuid.UUID(OWNER)
    assert row.approved_at is not None

    proposal = client.post(f"/estimates/{estimate_id}/proposals")
    assert proposal.status_code == 201
    assert proposal.json()["status"] == "draft"
    assert proposal.json()["public_token"]


def test_double_approval_rejected(client: TestClient) -> None:
    _, estimate_id = _draft_estimate(client)
    client.post(f"/estimates/{estimate_id}/approve", json={"confirmations": ALL_CONFIRMATIONS})
    res = client.post(
        f"/estimates/{estimate_id}/approve", json={"confirmations": ALL_CONFIRMATIONS}
    )
    assert res.status_code == 409


# ── immutability of approved estimates ───────────────────────────────────────


def test_approved_estimate_is_immutable(client: TestClient) -> None:
    _, estimate_id = _draft_estimate(client)
    detail = client.get(f"/estimates/{estimate_id}").json()
    line_id = detail["lines"][0]["id"]
    client.post(f"/estimates/{estimate_id}/approve", json={"confirmations": ALL_CONFIRMATIONS})

    mutations = [
        ("PATCH", f"/estimates/{estimate_id}", {"margin_override_pct": "60"}),
        ("POST", f"/estimates/{estimate_id}/lines", {"description": "x", "unit_price": "1"}),
        ("PATCH", f"/estimates/{estimate_id}/lines/{line_id}", {"qty": "2"}),
        ("DELETE", f"/estimates/{estimate_id}/lines/{line_id}", None),
        ("POST", f"/estimates/{estimate_id}/lines/{line_id}/convert", {"amount": "1"}),
        (
            "POST",
            f"/estimates/{estimate_id}/lines/{line_id}/options",
            {"tiers": [{"tier": "good", "label": "G", "total": "1"},
                       {"tier": "better", "label": "B", "total": "2"}]},
        ),
    ]
    for method, url, payload in mutations:
        res = client.request(method, url, json=payload)
        assert res.status_code == 409, f"{method} {url} was not blocked"
        assert res.json()["error"]["details"]["code"] == "fork_required", f"{method} {url}"


def test_fork_creates_next_draft_version_and_supersede_on_approval(
    client: TestClient,
) -> None:
    _, estimate_id = _draft_estimate(client)
    client.post(f"/estimates/{estimate_id}/approve", json={"confirmations": ALL_CONFIRMATIONS})

    fork = client.post(f"/estimates/{estimate_id}/fork").json()
    assert fork["version"] == 2
    assert fork["status"] == "draft"
    assert fork["source"] == "duplicate"
    assert len(fork["lines"]) == 1  # lines copied

    # editing the fork works; the original stays approved and untouched
    res = client.patch(
        f"/estimates/{fork['id']}/lines/{fork['lines'][0]['id']}", json={"qty": "3"}
    )
    assert res.status_code == 200
    original = client.get(f"/estimates/{estimate_id}").json()
    assert original["status"] == "approved"
    assert original["lines"][0]["qty"] == "1"

    # approving the fork supersedes the original
    client.post(f"/estimates/{fork['id']}/approve", json={"confirmations": ALL_CONFIRMATIONS})
    original = client.get(f"/estimates/{estimate_id}").json()
    assert original["status"] == "superseded"

    # superseded versions are read-only
    res = client.patch(f"/estimates/{estimate_id}", json={"scope_prose": "hack"})
    assert res.status_code == 409

    # diff between versions reports the change
    diff = client.get(f"/estimates/{estimate_id}/diff/{fork['id']}").json()
    assert diff["from_version"] == 1 and diff["to_version"] == 2
    assert len(diff["changed"]) == 1
    assert diff["changed"][0]["after"]["qty"] == "3"
