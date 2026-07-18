"""Catalog + pricing-preview API integration tests (live Postgres).

Covers: assembly list/search, role-gated PATCH with version bump + audit,
the pricing preview endpoint driving the deterministic engine end to end,
and pricing-error mapping onto the API envelope.
"""

import os
import uuid
from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import Session, sessionmaker

pytestmark = pytest.mark.db

DB_URL = os.environ.get("FQ_RLS_DB_URL", "")
if not DB_URL:
    pytest.skip("FQ_RLS_DB_URL not set (use scripts/test_rls.sh)", allow_module_level=True)

from fieldquote.core.auth import AuthContext, get_auth  # noqa: E402
from fieldquote.core.db import get_db  # noqa: E402
from fieldquote.domain.models import Assembly, AuditLog, MaterialItem, Modifier, User  # noqa: E402
from fieldquote.main import create_app  # noqa: E402

OWNER = str(uuid.uuid4())
TECH = str(uuid.uuid4())
_current_user: dict[str, str] = {"id": OWNER}


@pytest.fixture(scope="module")
def app() -> Iterator[FastAPI]:
    os.environ["DATABASE_URL"] = DB_URL
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config("alembic.ini"), "head")

    engine = create_engine(DB_URL)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    with session_factory() as session:
        session.execute(delete(Assembly).where(Assembly.code.like("t2test_%")))
        session.execute(delete(MaterialItem).where(MaterialItem.sku.like("T2TEST-%")))
        session.execute(delete(Modifier).where(Modifier.code.like("t2test_%")))
        session.add_all(
            [
                MaterialItem(
                    sku="T2TEST-WIRE",
                    description="test wire per ft",
                    unit="ft",
                    base_price=Decimal("1.00"),
                    region_multipliers={},
                ),
                Modifier(
                    code="t2test_attic",
                    name="Attic run",
                    effect={"labor_hours_add": "0.5"},
                ),
                Assembly(
                    code="t2test_circuit",
                    name="Test 20A circuit",
                    job_type_codes=["circuits_outlets"],
                    labor_hours=Decimal("2.0"),
                    bom=[{"sku": "T2TEST-WIRE", "qty": "50"}],
                    modifiers_allowed=["t2test_attic"],
                    status="draft",
                ),
                # Dedicated to the preview test — other tests PATCH
                # t2test_circuit, so its hours are not stable.
                Assembly(
                    code="t2test_preview",
                    name="Test preview circuit",
                    job_type_codes=["circuits_outlets"],
                    labor_hours=Decimal("2.0"),
                    bom=[{"sku": "T2TEST-WIRE", "qty": "50"}],
                    modifiers_allowed=["t2test_attic"],
                    status="draft",
                ),
            ]
        )
        session.commit()

    def override_db() -> Iterator[Session]:
        with session_factory() as session:
            yield session

    application = create_app()
    application.dependency_overrides[get_db] = override_db
    application.dependency_overrides[get_auth] = lambda: AuthContext(
        user_id=_current_user["id"], email="phase2@test.dev"
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


def test_list_and_search_assemblies(client: TestClient) -> None:
    items = client.get("/catalog/assemblies").json()["items"]
    codes = {item["code"] for item in items}
    assert "t2test_circuit" in codes

    found = client.get("/catalog/assemblies", params={"q": "t2test_circ"}).json()["items"]
    assert [item["code"] for item in found] == ["t2test_circuit"]

    by_type = client.get(
        "/catalog/assemblies", params={"job_type": "circuits_outlets"}
    ).json()["items"]
    assert "t2test_circuit" in {item["code"] for item in by_type}


def test_patch_bumps_version_and_audits(client: TestClient, db: Session) -> None:
    res = client.patch(
        "/catalog/assemblies/t2test_circuit",
        json={"labor_hours": "2.5", "labor_notes": "advisor adjusted"},
    )
    assert res.status_code == 200
    body = res.json()
    assert Decimal(body["labor_hours"]) == Decimal("2.5")
    assert body["version"] == 2

    entry = db.scalars(
        select(AuditLog)
        .where(AuditLog.entity == "assembly", AuditLog.action == "catalog_update")
        .order_by(AuditLog.created_at.desc())
    ).first()
    assert entry is not None
    assert entry.after is not None and entry.after["version"] == 2


def test_patch_requires_owner_or_admin(client: TestClient, db: Session) -> None:
    # First call as TECH auto-provisions a fresh company with role owner;
    # downgrade that user to tech to exercise the gate.
    _current_user["id"] = TECH
    client.get("/me")
    tech_user = db.get(User, uuid.UUID(TECH))
    assert tech_user is not None
    tech_user.role = "tech"
    db.commit()

    res = client.patch("/catalog/assemblies/t2test_circuit", json={"labor_hours": "9"})
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "forbidden"


def test_status_flip_to_advisor_approved(client: TestClient) -> None:
    res = client.patch("/catalog/assemblies/t2test_circuit", json={"status": "advisor_approved"})
    assert res.status_code == 200
    assert res.json()["status"] == "advisor_approved"
    # flip back so other tests see a draft
    client.patch("/catalog/assemblies/t2test_circuit", json={"status": "draft"})


def test_pricing_preview_end_to_end(client: TestClient) -> None:
    put = client.put(
        "/company/rates",
        json={
            "labor_rate": "100",
            "target_margin_pct": "50",
            "tax_rate_pct": "0",
            "markup_model": "margin",
        },
    )
    assert put.status_code == 200

    res = client.post(
        "/pricing/preview",
        json={
            "assemblies": [
                {"code": "t2test_preview", "qty": 1, "modifiers": ["t2test_attic"]}
            ]
        },
    )
    assert res.status_code == 200
    body = res.json()
    # materials 50 x 1.00 = 50; labor (2.0 + 0.5)h x 100 = 250; cost 300 -> 600
    assert Decimal(body["lines"][0]["total"]) == Decimal("600.00")
    assert Decimal(body["total"]) == Decimal("600.00")
    assert body["engine_version"]
    assert body["lines"][0]["breakdown"]["modifier_applications"][0]["code"] == "t2test_attic"


def test_pricing_preview_unknown_assembly_maps_to_envelope(client: TestClient) -> None:
    res = client.post(
        "/pricing/preview", json={"assemblies": [{"code": "no_such_assembly"}]}
    )
    assert res.status_code == 422
    error = res.json()["error"]
    assert error["code"] == "pricing_error"
    assert error["details"]["code"] == "unknown_assembly"
