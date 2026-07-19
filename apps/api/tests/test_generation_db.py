"""Live-DB integration tests for captures API + the generation orchestrator.

Runs the WHOLE pipeline with fake providers against real Postgres: captures →
ASR/vision (fakes) → scoping (fake fixture output) → pricing engine (real,
seeded catalog rows) → draft estimate with lines. Also proves the failure
path records generation_failed with a user-safe reason."""

import json
import os
import uuid
from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, delete
from sqlalchemy.orm import Session, sessionmaker

pytestmark = pytest.mark.db

DB_URL = os.environ.get("FQ_RLS_DB_URL", "")
if not DB_URL:
    pytest.skip("FQ_RLS_DB_URL not set (use scripts/test_rls.sh)", allow_module_level=True)

from fieldquote.ai.asr.fake import FakeASR  # noqa: E402
from fieldquote.ai.scoping.fake import FakeScoping  # noqa: E402
from fieldquote.ai.types import GenerationFailure, ScopingOutput, VisionFindings  # noqa: E402
from fieldquote.ai.vision.fake import FakeVision  # noqa: E402
from fieldquote.core.auth import AuthContext, get_auth  # noqa: E402
from fieldquote.core.db import get_db  # noqa: E402
from fieldquote.domain.models import (  # noqa: E402
    Assembly,
    MaterialItem,
    Modifier,
)
from fieldquote.integrations.storage import FakeStorage, get_storage  # noqa: E402
from fieldquote.main import create_app  # noqa: E402
from fieldquote.services.events import FakeEventBus  # noqa: E402
from fieldquote.services.generation import (  # noqa: E402
    Providers,
    record_failure,
    run_generation,
)
from fieldquote.services.queue import FakeQueue, get_queue  # noqa: E402

USER = str(uuid.uuid4())
STORAGE = FakeStorage()
QUEUE = FakeQueue()


@pytest.fixture(scope="module")
def app() -> Iterator[FastAPI]:
    os.environ["DATABASE_URL"] = DB_URL
    from alembic import command
    from alembic.config import Config

    command.upgrade(Config("alembic.ini"), "head")

    engine = create_engine(DB_URL)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)

    with session_factory() as session:
        session.execute(delete(Assembly).where(Assembly.code.like("t3gen_%")))
        session.execute(delete(MaterialItem).where(MaterialItem.sku.like("T3GEN-%")))
        session.execute(delete(Modifier).where(Modifier.code.like("t3gen_%")))
        session.add_all(
            [
                MaterialItem(
                    sku="T3GEN-WIRE",
                    description="wire",
                    unit="ft",
                    base_price=Decimal("2.00"),
                    region_multipliers={},
                ),
                Modifier(code="t3gen_attic", name="Attic", effect={"labor_hours_add": "1"}),
                Assembly(
                    code="t3gen_circuit",
                    name="Gen test circuit",
                    job_type_codes=["circuits_outlets"],
                    labor_hours=Decimal("2.0"),
                    bom=[{"sku": "T3GEN-WIRE", "qty": "25"}],
                    modifiers_allowed=["t3gen_attic"],
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
        user_id=USER, email="phase3@test.dev"
    )
    application.dependency_overrides[get_storage] = lambda: STORAGE
    application.dependency_overrides[get_queue] = lambda: QUEUE
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


def _scoping_output() -> ScopingOutput:
    return ScopingOutput.model_validate(
        {
            "job_type_code": "circuits_outlets",
            "assemblies": [
                {
                    "code": "t3gen_circuit",
                    "qty": 2,
                    "modifiers": ["t3gen_attic"],
                    "evidence": "transcript: 'two circuits through the attic'",
                }
            ],
            "allowances": [
                {
                    "description": "Drywall patching by others",
                    "suggested_amount_basis": "verify",
                    "reason": "wall condition unknown",
                }
            ],
            "verify_flags": [
                {"item": "Panel capacity", "action": "verify breaker space on site"}
            ],
            "scope_prose": "We will install two dedicated 20-amp circuits routed "
            "through the attic to serve the workshop.",
            "questions_for_contractor": ["Confirm receptacle locations"],
        }
    )


def _providers(scoping: FakeScoping | None = None) -> Providers:
    return Providers(
        asr=FakeASR("two circuits through the attic"),
        asr_fallback=None,
        vision=FakeVision(
            VisionFindings.model_validate(
                {"panel": {"brand": "Square D", "amperage": 200}, "provider": "fake"}
            )
        ),
        scoping=scoping or FakeScoping(_scoping_output()),
    )


def _make_job_with_captures(client: TestClient) -> uuid.UUID:
    job_id = uuid.UUID(
        client.post("/jobs", json={"title": "Gen test", "job_type_code": "circuits_outlets"})
        .json()["id"]
    )
    for kind in ("audio", "photo"):
        created = client.post(f"/jobs/{job_id}/captures", json={"kind": kind}).json()
        STORAGE.seed(
            "job-audio" if kind == "audio" else "job-photos",
            created["capture"]["storage_path"],
            b"fake-bytes",
        )
        done = client.post(f"/captures/{created['capture']['id']}/complete")
        assert done.json()["upload_state"] == "uploaded"
    return job_id


def test_capture_flow_and_generation_end_to_end(client: TestClient, db: Session) -> None:
    job_id = _make_job_with_captures(client)

    # generate endpoint queues the arq task
    res = client.post(f"/jobs/{job_id}/estimates/generate")
    assert res.status_code == 202
    assert str(job_id) in QUEUE.enqueued

    # run the orchestrator the way the worker would
    bus = FakeEventBus()
    estimate = run_generation(db, job_id, _providers(), STORAGE, bus)

    assert estimate.status == "draft"  # §0.1.2 — always a draft
    assert estimate.version == 1
    assert estimate.scope_prose and "two dedicated 20-amp circuits" in estimate.scope_prose

    detail = client.get(f"/estimates/{estimate.id}").json()
    types = [line["line_type"] for line in detail["lines"]]
    assert types == ["standard", "allowance", "verify"]

    standard = detail["lines"][0]
    # engine math: hours (2.0 + 1.0 attic) x qty 2 = 6.0h; materials 25ft x $2 x2 = 100
    assert Decimal(standard["labor_hours"]) == Decimal("6.00")
    assert Decimal(standard["material_cost"]) == Decimal("100.00")
    assert standard["price_source"] == "engine"

    allowance = detail["lines"][1]
    assert allowance["confidence"] == "allowance"
    assert Decimal(str(allowance["totals"]["total"])) == Decimal("0")  # LLM never prices

    verify = detail["lines"][2]
    assert verify["confidence"] == "verify"
    assert verify["description"] == "Panel capacity"

    assert detail["totals"]["engine_version"]
    assert detail["ai_output"]["assemblies"][0]["evidence"]

    events = [event for _, event, _ in bus.events]
    assert events[0] == "generation.started"
    assert "scope.partial" in events
    assert events[-1] == "estimate.ready"

    # transcript + findings were persisted onto captures
    captures = client.get(f"/jobs/{job_id}/captures").json()
    audio = next(c for c in captures if c["kind"] == "audio")
    photo = next(c for c in captures if c["kind"] == "photo")
    assert audio["has_transcript"] and photo["has_vision_findings"]


def test_generation_versions_increment(client: TestClient, db: Session) -> None:
    job_id = _make_job_with_captures(client)
    bus = FakeEventBus()
    first = run_generation(db, job_id, _providers(), STORAGE, bus)
    second = run_generation(db, job_id, _providers(), STORAGE, bus)
    assert (first.version, second.version) == (1, 2)


def test_generation_failure_recorded_user_safe(client: TestClient, db: Session) -> None:
    job_id = _make_job_with_captures(client)
    bus = FakeEventBus()
    bad = ScopingOutput.model_validate(
        {
            "job_type_code": "circuits_outlets",
            "assemblies": [{"code": "not_real", "qty": 1, "evidence": "x"}],
            "scope_prose": "prose",
        }
    )
    failing = FakeScoping(bad, repaired_output=bad)
    with pytest.raises(GenerationFailure) as excinfo:
        run_generation(db, job_id, _providers(failing), STORAGE, bus)
    estimate = record_failure(db, job_id, excinfo.value, bus)
    assert estimate is not None and estimate.status == "generation_failed"
    assert estimate.ai_output is not None
    assert "not_real" not in estimate.ai_output["error"]  # raw model errors stay internal
    assert any(event == "generation.failed" for _, event, _ in bus.events)


def test_generate_endpoint_requires_uploaded_capture(client: TestClient) -> None:
    job_id = client.post("/jobs", json={"title": "Empty job"}).json()["id"]
    res = client.post(f"/jobs/{job_id}/estimates/generate")
    assert res.status_code == 409


def test_generation_requires_captures(db: Session, client: TestClient) -> None:
    job_id = uuid.UUID(client.post("/jobs", json={"title": "No captures"}).json()["id"])
    with pytest.raises(GenerationFailure):
        run_generation(db, job_id, _providers(), STORAGE, FakeEventBus())


def test_outside_scope_creates_lineless_draft(client: TestClient, db: Session) -> None:
    job_id = _make_job_with_captures(client)
    outside = ScopingOutput.model_validate(
        {
            "job_type_code": "other",
            "assemblies": [],
            "scope_prose": "This request is outside the electrical work we support.",
            "outside_supported_scope": True,
            "outside_reason": "Water heater replacement is plumbing work.",
        }
    )
    estimate = run_generation(
        db, job_id, _providers(FakeScoping(outside)), STORAGE, FakeEventBus()
    )
    assert estimate.status == "draft"
    detail = client.get(f"/estimates/{estimate.id}").json()
    assert detail["lines"] == []
    assert detail["ai_output"]["outside_supported_scope"] is True
    assert json.loads(json.dumps(detail["totals"]))["total"] == "0"
