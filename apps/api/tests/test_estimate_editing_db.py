"""Estimate editing integration tests: engine repricing on qty/modifier
changes, manual overrides with `edited` badges + audit, the margin slider,
allowance conversion, the options builder, and checklist suggestions."""

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

from fieldquote.ai.scoping.checklist import ChecklistOutput, FakeChecklist  # noqa: E402
from fieldquote.core.auth import AuthContext, get_auth  # noqa: E402
from fieldquote.core.db import get_db  # noqa: E402
from fieldquote.domain.models import Assembly, AuditLog, MaterialItem, Modifier  # noqa: E402
from fieldquote.main import create_app  # noqa: E402
from fieldquote.routers.estimates import get_checklist_model  # noqa: E402

USER = str(uuid.uuid4())
CHECKLIST = FakeChecklist(
    ChecklistOutput.model_validate(
        {
            "suggestions": [
                {"assembly_code": "t5ed_circuit", "description": "Add a circuit", "reason": "r"},
                {"assembly_code": "bogus_code", "description": "Invalid", "reason": "r"},
                {"assembly_code": None, "description": "Confirm HOA rules", "reason": "r"},
            ]
        }
    )
)


@pytest.fixture(scope="module")
def app() -> Iterator[FastAPI]:
    os.environ["DATABASE_URL"] = DB_URL
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config("alembic.ini"), "head")
    engine = create_engine(DB_URL)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    with session_factory() as session:
        session.execute(delete(Assembly).where(Assembly.code.like("t5ed_%")))
        session.execute(delete(MaterialItem).where(MaterialItem.sku.like("T5ED-%")))
        session.execute(delete(Modifier).where(Modifier.code.like("t5ed_%")))
        session.add_all(
            [
                MaterialItem(
                    sku="T5ED-WIRE",
                    description="wire",
                    unit="ft",
                    base_price=Decimal("1.00"),
                    region_multipliers={},
                ),
                Modifier(code="t5ed_attic", name="Attic", effect={"labor_hours_add": "1"}),
                Assembly(
                    code="t5ed_circuit",
                    name="Edit test circuit",
                    job_type_codes=["circuits_outlets"],
                    labor_hours=Decimal("2.0"),
                    bom=[{"sku": "T5ED-WIRE", "qty": "50"}],
                    modifiers_allowed=["t5ed_attic"],
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
        user_id=USER, email="phase5ed@test.dev"
    )
    application.dependency_overrides[get_checklist_model] = lambda: CHECKLIST
    yield application
    engine.dispose()


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def db() -> Iterator[Session]:
    engine = create_engine(DB_URL)
    with Session(engine) as session:
        yield session
    engine.dispose()


@pytest.fixture
def estimate(client: TestClient) -> dict[str, object]:
    client.put(
        "/company/rates",
        json={
            "labor_rate": "100",
            "target_margin_pct": "50",
            "tax_rate_pct": "0",
            "markup_model": "margin",
        },
    )
    job_id = client.post("/jobs", json={"title": "Edit test"}).json()["id"]
    est = client.post(f"/jobs/{job_id}/estimates", json={}).json()
    return est  # type: ignore[no-any-return]


def _add_engine_line(client: TestClient, estimate_id: str) -> dict[str, object]:
    detail = client.post(
        f"/estimates/{estimate_id}/lines",
        json={"assembly_code": "t5ed_circuit", "qty": 1},
    ).json()
    return detail["lines"][-1]  # type: ignore[no-any-return]


def test_add_engine_line_prices_via_engine(client: TestClient, estimate: dict) -> None:
    line = _add_engine_line(client, str(estimate["id"]))
    # materials 50 x 1.00 = 50; labor 2h x 100 = 200; cost 250 -> 500 at 50%
    assert Decimal(str(line["totals"]["total"])) == Decimal("500.00")
    assert line["price_source"] == "engine"
    assert line["totals"]["breakdown"]["cost_total"] == "250.00"
    detail = client.get(f"/estimates/{estimate['id']}").json()
    assert Decimal(str(detail["totals"]["total"])) == Decimal("500.00")


def test_qty_change_repricies_through_engine(client: TestClient, estimate: dict) -> None:
    line = _add_engine_line(client, str(estimate["id"]))
    detail = client.patch(
        f"/estimates/{estimate['id']}/lines/{line['id']}", json={"qty": "3"}
    ).json()
    updated = next(entry for entry in detail["lines"] if entry["id"] == line["id"])
    assert Decimal(str(updated["totals"]["total"])) == Decimal("1500.00")
    assert updated["price_source"] == "engine"
    assert updated["totals"]["overrides"] == {}


def test_modifier_change_repricies(client: TestClient, estimate: dict) -> None:
    line = _add_engine_line(client, str(estimate["id"]))
    detail = client.patch(
        f"/estimates/{estimate['id']}/lines/{line['id']}",
        json={"modifiers": ["t5ed_attic"]},
    ).json()
    updated = next(entry for entry in detail["lines"] if entry["id"] == line["id"])
    # hours 2+1=3 -> labor 300 + 50 material = 350 cost -> 700
    assert Decimal(str(updated["totals"]["total"])) == Decimal("700.00")


def test_manual_override_badges_and_audits(
    client: TestClient, estimate: dict, db: Session
) -> None:
    line = _add_engine_line(client, str(estimate["id"]))
    detail = client.patch(
        f"/estimates/{estimate['id']}/lines/{line['id']}", json={"unit_price": "999"}
    ).json()
    updated = next(entry for entry in detail["lines"] if entry["id"] == line["id"])
    assert updated["price_source"] == "manual"
    assert updated["totals"]["overrides"]["unit_price"] is True
    assert Decimal(str(updated["totals"]["total"])) == Decimal("999.00")

    entry = db.scalars(
        select(AuditLog)
        .where(AuditLog.entity == "estimate_line", AuditLog.action == "line_update")
        .order_by(AuditLog.created_at.desc())
    ).first()
    assert entry is not None and entry.after is not None
    assert entry.after["total"] == "999.00"


def test_labor_hours_override_recomputes_deterministically(
    client: TestClient, estimate: dict
) -> None:
    line = _add_engine_line(client, str(estimate["id"]))
    detail = client.patch(
        f"/estimates/{estimate['id']}/lines/{line['id']}", json={"labor_hours": "4"}
    ).json()
    updated = next(entry for entry in detail["lines"] if entry["id"] == line["id"])
    # cost = 50 material + 4h x 100 = 450 -> 900.00 at 50% margin
    assert Decimal(str(updated["totals"]["total"])) == Decimal("900.00")
    assert updated["totals"]["overrides"]["labor_hours"] is True


def test_margin_slider_reprices_engine_lines_only(client: TestClient, estimate: dict) -> None:
    engine_line = _add_engine_line(client, str(estimate["id"]))
    client.post(
        f"/estimates/{estimate['id']}/lines",
        json={"description": "Manual thing", "unit_price": "100"},
    )
    detail = client.patch(
        f"/estimates/{estimate['id']}", json={"margin_override_pct": "60"}
    ).json()
    lines = {entry["description"]: entry for entry in detail["lines"]}
    # engine line: cost 250 -> 625.00 at 60%
    updated = next(entry for entry in detail["lines"] if entry["id"] == engine_line["id"])
    assert Decimal(str(updated["totals"]["total"])) == Decimal("625.00")
    # manual line untouched
    assert Decimal(str(lines["Manual thing"]["totals"]["total"])) == Decimal("100.00")
    assert detail["totals"]["margin_check"]["target_margin_pct"] == "60"


def test_allowance_convert(client: TestClient, estimate: dict) -> None:
    detail = client.post(
        f"/estimates/{estimate['id']}/lines",
        json={"description": "Load calc", "line_type": "allowance"},
    ).json()
    line = detail["lines"][-1]
    assert line["confidence"] == "allowance"
    converted = client.post(
        f"/estimates/{estimate['id']}/lines/{line['id']}/convert", json={"amount": "350"}
    ).json()
    updated = next(entry for entry in converted["lines"] if entry["id"] == line["id"])
    assert updated["line_type"] == "standard"
    assert updated["confidence"] == "known"
    assert Decimal(str(updated["totals"]["total"])) == Decimal("350.00")


def test_options_builder_replaces_line_with_tiers(client: TestClient, estimate: dict) -> None:
    line = _add_engine_line(client, str(estimate["id"]))
    detail = client.post(
        f"/estimates/{estimate['id']}/lines/{line['id']}/options",
        json={
            "tiers": [
                {"tier": "good", "label": "Standard", "total": "500"},
                {"tier": "better", "label": "Plus", "total": "700"},
                {"tier": "best", "label": "Premium", "total": "900"},
            ],
            "selected": "better",
        },
    ).json()
    option_lines = [
        entry for entry in detail["lines"] if str(entry["line_type"]).startswith("option_")
    ]
    assert [entry["line_type"] for entry in option_lines] == [
        "option_good",
        "option_better",
        "option_best",
    ]
    included = [entry for entry in option_lines if entry["totals"]["included"]]
    assert len(included) == 1 and included[0]["line_type"] == "option_better"
    # only the selected tier counts toward the total
    assert Decimal(str(detail["totals"]["total"])) == Decimal("700.00")


def test_delete_line_recomputes(client: TestClient, estimate: dict) -> None:
    line = _add_engine_line(client, str(estimate["id"]))
    detail = client.delete(f"/estimates/{estimate['id']}/lines/{line['id']}").json()
    assert all(entry["id"] != line["id"] for entry in detail["lines"])
    assert Decimal(str(detail["totals"]["total"])) == Decimal("0.00")


def test_suggestions_filters_invalid_codes(client: TestClient, estimate: dict) -> None:
    res = client.post(f"/estimates/{estimate['id']}/suggestions")
    assert res.status_code == 200
    suggestions = res.json()["suggestions"]
    codes = [entry["assembly_code"] for entry in suggestions]
    assert "t5ed_circuit" in codes
    assert "bogus_code" not in codes  # invalid catalog codes filtered
    assert None in codes  # free-form suggestion allowed
    assert len(suggestions) <= 5
