"""Phase 6 end-to-end money loop against live Postgres (Stripe faked):
approve → proposal → send (immutable snapshot) → public view → sign
(signature hash + deposit invoice) → Connect onboarding → checkout →
webhook (idempotent) → deposit paid → job advances to won.

Also proves immutability: a sent proposal can't be edited, and replayed
webhooks don't double-charge."""

import json
import os
import uuid
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

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
from fieldquote.domain.models import (  # noqa: E402
    Invoice,
    Job,
    Payment,
    Proposal,
    Signature,
)
from fieldquote.integrations.storage import FakeStorage, get_storage  # noqa: E402
from fieldquote.integrations.stripe import FakeStripe, get_stripe  # noqa: E402
from fieldquote.main import create_app  # noqa: E402
from fieldquote.services.queue import FakeQueue, get_queue  # noqa: E402

USER = str(uuid.uuid4())
STORAGE = FakeStorage()
STRIPE = FakeStripe("whsec_test")
QUEUE = FakeQueue()
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
        user_id=USER, email="phase6@test.dev"
    )
    application.dependency_overrides[get_storage] = lambda: STORAGE
    application.dependency_overrides[get_stripe] = lambda: STRIPE
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


def _approved_estimate(client: TestClient) -> tuple[str, str]:
    client.put(
        "/company/rates",
        json={"labor_rate": "100", "target_margin_pct": "50", "tax_rate_pct": "0"},
    )
    job_id = client.post("/jobs", json={"title": "Panel upgrade"}).json()["id"]
    estimate = client.post(f"/jobs/{job_id}/estimates", json={}).json()
    client.post(
        f"/estimates/{estimate['id']}/lines",
        json={"description": "200A panel upgrade", "unit_price": "4000", "qty": 1},
    )
    client.post(
        f"/estimates/{estimate['id']}/approve", json={"confirmations": ALL_CONFIRMATIONS}
    )
    return job_id, estimate["id"]


def _proposal(client: TestClient) -> tuple[str, dict[str, Any]]:
    _, estimate_id = _approved_estimate(client)
    proposal = client.post(f"/estimates/{estimate_id}/proposals").json()
    return estimate_id, proposal


def test_send_freezes_immutable_snapshot(client: TestClient, db: Session) -> None:
    _, proposal = _proposal(client)
    # configure the composer
    client.patch(
        f"/proposals/{proposal['id']}",
        json={
            "title": "Panel Upgrade Proposal",
            "intro_message": "Thanks for the opportunity.",
            "deposit": {"kind": "percent", "value": "25"},
            "validity_days": 30,
        },
    )
    sent = client.post(f"/proposals/{proposal['id']}/send").json()
    assert sent["status"] == "sent"
    assert sent["content_hash"]
    assert sent["document"]["deposit_amount"] == "1000.00"  # 25% of 4000
    assert proposal["id"] in QUEUE.delivered  # delivery queued

    # snapshot + html stored
    row = db.get(Proposal, uuid.UUID(proposal["id"]))
    assert row is not None and row.snapshot is not None
    assert f"documents/{row.html_snapshot_path}" in STORAGE.objects

    # editing a sent proposal is refused
    res = client.patch(f"/proposals/{proposal['id']}", json={"title": "hack"})
    assert res.status_code == 409
    assert res.json()["error"]["details"]["code"] == "already_sent"
    # re-send refused
    assert client.post(f"/proposals/{proposal['id']}/send").status_code == 409


def test_public_view_tracks_and_hides_drafts(client: TestClient) -> None:
    _, proposal = _proposal(client)
    token = proposal["public_token"]
    # draft is not public
    assert client.get(f"/p/{token}").status_code == 404
    client.post(f"/proposals/{proposal['id']}/send")
    view = client.get(f"/p/{token}").json()
    assert view["status"] == "viewed"
    assert view["document"]["title"]
    # view count increments
    client.get(f"/p/{token}")
    detail = client.get(f"/proposals/{proposal['id']}").json()
    assert detail["view_count"] >= 2
    assert detail["first_viewed_at"] is not None


def test_full_money_loop(client: TestClient, db: Session) -> None:
    _, proposal = _proposal(client)
    proposal_id = proposal["id"]
    token = proposal["public_token"]
    client.post(f"/proposals/{proposal_id}/send")

    # sign: consent required
    assert (
        client.post(f"/p/{token}/sign", json={"signer_name": "Sarah", "consent": False}).status_code
        == 409
    )
    signed = client.post(
        f"/p/{token}/sign",
        json={"signer_name": "Sarah Chen", "signer_email": "sarah@example.com", "consent": True},
    ).json()
    assert signed["status"] == "signed"
    assert signed["signed"] is True
    assert signed["payment"]["deposit_amount"] == "1000.00"

    sig = db.scalar(
        select(Signature).where(Signature.proposal_id == uuid.UUID(proposal_id))
    )
    assert sig is not None and len(sig.signature_hash) == 64

    invoice = db.scalar(
        select(Invoice).where(Invoice.proposal_id == uuid.UUID(proposal_id))
    )
    assert invoice is not None and invoice.kind == "deposit"
    assert invoice.total == Decimal("1000.00")
    assert invoice.application_fee == Decimal("25.00")  # 2.5% of 1000

    # checkout blocked until Connect is ready
    assert client.post(f"/p/{token}/checkout").status_code == 409

    # onboard Connect + mark ready via webhook
    link = client.post("/stripe/connect/onboard").json()
    assert link["url"].startswith("https://connect.stripe.test/")
    status = client.get("/stripe/connect/status").json()
    account_id = status["account_id"]
    assert account_id is not None
    STRIPE.mark_account_ready(account_id)

    evt_acct = f"evt_acct_{uuid.uuid4().hex}"
    account_event = json.dumps(
        {
            "id": evt_acct,
            "type": "account.updated",
            "data": {"object": {"id": account_id, "charges_enabled": True}},
        }
    ).encode()
    res = client.post(
        "/webhooks/stripe",
        content=account_event,
        headers={"stripe-signature": STRIPE.sign(account_event)},
    )
    assert res.status_code == 200

    # now checkout works
    assert client.get("/stripe/connect/status").json()["charges_enabled"] is True
    checkout = client.post(f"/p/{token}/checkout").json()
    assert "url" in checkout, checkout
    assert checkout["url"].startswith("https://checkout.stripe.test/")
    db.expire_all()
    invoice = db.get(Invoice, invoice.id)
    assert invoice is not None and invoice.stripe_checkout_session_id is not None

    # webhook: checkout completed → paid, job → won
    evt_paid = f"evt_paid_{uuid.uuid4().hex}"
    paid_event = json.dumps(
        {
            "id": evt_paid,
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": invoice.stripe_checkout_session_id,
                    "amount_total": 100000,
                    "payment_intent": "pi_deposit_1",
                    "metadata": {"invoice_id": str(invoice.id)},
                }
            },
        }
    ).encode()
    header = STRIPE.sign(paid_event)
    paid_res = client.post(
        "/webhooks/stripe", content=paid_event, headers={"stripe-signature": header}
    )
    assert paid_res.status_code == 200

    db.expire_all()
    invoice = db.get(Invoice, invoice.id)
    assert invoice is not None and invoice.status == "paid"
    assert invoice.paid_at is not None
    payment = db.scalar(select(Payment).where(Payment.invoice_id == invoice.id))
    assert payment is not None
    assert payment.amount == Decimal("1000.00")
    assert payment.net == Decimal("975.00")  # 1000 - 25 fee
    job = db.get(Job, invoice.job_id)
    assert job is not None and job.status == "won"

    # REPLAY the same event → idempotent (no second payment, still paid)
    replay = client.post(
        "/webhooks/stripe", content=paid_event, headers={"stripe-signature": header}
    )
    assert replay.status_code == 200
    db.expire_all()
    payments = db.scalars(select(Payment).where(Payment.invoice_id == invoice.id)).all()
    assert len(payments) == 1


def test_webhook_bad_signature_rejected(client: TestClient) -> None:
    event = json.dumps({"id": "evt_x", "type": "account.updated", "data": {"object": {}}}).encode()
    res = client.post(
        "/webhooks/stripe", content=event, headers={"stripe-signature": "t=1,v1=deadbeef"}
    )
    assert res.status_code == 400


def test_decline_path(client: TestClient) -> None:
    _, proposal = _proposal(client)
    token = proposal["public_token"]
    client.post(f"/proposals/{proposal['id']}/send")
    declined = client.post(f"/p/{token}/decline", json={"reason": "Went with someone else"}).json()
    assert declined["status"] == "declined"
    # can't sign a declined proposal
    assert (
        client.post(f"/p/{token}/sign", json={"signer_name": "X", "consent": True}).status_code
        == 409
    )


def test_signed_proposal_cannot_be_signed_twice(client: TestClient) -> None:
    _, proposal = _proposal(client)
    token = proposal["public_token"]
    client.post(f"/proposals/{proposal['id']}/send")
    client.post(f"/p/{token}/sign", json={"signer_name": "Sarah", "consent": True})
    res = client.post(f"/p/{token}/sign", json={"signer_name": "Sarah", "consent": True})
    assert res.status_code == 409
