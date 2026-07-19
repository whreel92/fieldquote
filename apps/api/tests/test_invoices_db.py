"""Phase 7 invoice lifecycle against live Postgres.

Flow: signed proposal creates the deposit invoice, won job creates progress
invoice by percent, send locks it, final invoice auto-computes the remaining
contract balance, Money summary reflects outstanding receivables.
"""

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
from fieldquote.domain.models import Company, Invoice, Job, Payment  # noqa: E402
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
        user_id=USER, email="phase7@test.dev"
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


def _signed_proposal(client: TestClient) -> tuple[str, str]:
    client.put(
        "/company/rates",
        json={"labor_rate": "100", "target_margin_pct": "50", "tax_rate_pct": "0"},
    )
    job_id = client.post("/jobs", json={"title": "Phase 7 invoice job"}).json()["id"]
    estimate = client.post(f"/jobs/{job_id}/estimates", json={}).json()
    client.post(
        f"/estimates/{estimate['id']}/lines",
        json={"description": "200A panel upgrade", "unit_price": "4000", "qty": 1},
    )
    client.post(
        f"/estimates/{estimate['id']}/approve", json={"confirmations": ALL_CONFIRMATIONS}
    )
    proposal = client.post(f"/estimates/{estimate['id']}/proposals").json()
    client.patch(
        f"/proposals/{proposal['id']}",
        json={"deposit": {"kind": "percent", "value": "25"}},
    )
    client.post(f"/proposals/{proposal['id']}/send")
    client.post(
        f"/p/{proposal['public_token']}/sign",
        json={"signer_name": "Sarah", "consent": True},
    )
    return job_id, proposal["id"]


def test_progress_and_final_invoice_lifecycle(client: TestClient, db: Session) -> None:
    job_id, proposal_id = _signed_proposal(client)

    # Invoicing opens once the job is won; the deposit payment webhook normally
    # performs this transition.
    job = db.get(Job, uuid.UUID(job_id))
    assert job is not None
    job.status = "won"
    db.commit()

    deposit = db.scalar(select(Invoice).where(Invoice.proposal_id == uuid.UUID(proposal_id)))
    assert deposit is not None and deposit.total == Decimal("1000.00")

    progress = client.post(
        f"/jobs/{job_id}/invoices",
        json={"kind": "progress", "percent": "25", "description": "Rough-in payment"},
    ).json()
    assert progress["status"] == "draft"
    assert progress["total"] == "1000.00"

    sent = client.post(f"/invoices/{progress['id']}/send").json()
    assert sent["status"] == "sent"
    assert sent["public_token"]
    assert client.patch(f"/invoices/{progress['id']}", json={"amount": "900"}).status_code == 409

    final_invoice = client.post(f"/jobs/{job_id}/invoices", json={"kind": "final"}).json()
    assert final_invoice["kind"] == "final"
    assert final_invoice["total"] == "2000.00"

    summary: dict[str, Any] = client.get("/money/summary").json()
    assert Decimal(str(summary["outstanding"])) == Decimal("2000.00")
    invoice_ids = {row["id"] for row in summary["invoices"]}
    assert progress["id"] in invoice_ids
    assert final_invoice["id"] in invoice_ids


def _post_webhook(client: TestClient, event: dict[str, Any]) -> None:
    payload = json.dumps(event).encode()
    res = client.post(
        "/webhooks/stripe", content=payload, headers={"stripe-signature": STRIPE.sign(payload)}
    )
    assert res.status_code == 200


def _checkout_completed_event(session_id: str, intent_id: str, amount_cents: int) -> dict[str, Any]:
    return {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": session_id,
                "amount_total": amount_cents,
                "payment_intent": intent_id,
            }
        },
    }


def test_public_pay_page_partial_ach_and_refund(client: TestClient, db: Session) -> None:
    """The Phase 7 money loop: hosted pay page → ACH partial payment (real
    fee/net from the balance transaction) → card payment clears the balance →
    receipt queued per payment → manual refund → charge.refunded replay is a
    no-op."""
    job_id, _proposal_id = _signed_proposal(client)
    job = db.get(Job, uuid.UUID(job_id))
    assert job is not None
    job.status = "won"
    # Contractor can accept charges (normally set by Connect onboarding + webhook).
    company = db.get(Company, job.company_id)
    assert company is not None
    company.stripe_account_id = f"acct_{uuid.uuid4().hex[:12]}"
    company.stripe_charges_enabled = True
    db.commit()

    progress = client.post(
        f"/jobs/{job_id}/invoices", json={"kind": "progress", "amount": "1000"}
    ).json()
    sent = client.post(f"/invoices/{progress['id']}/send").json()
    token = sent["public_token"]
    invoice_id = uuid.UUID(progress["id"])

    # Public view: line items + payment availability, no auth header needed.
    view = client.get(f"/i/{token}").json()
    assert view["number"] == sent["number"]
    assert view["balance_due"] == "1000.00"
    assert view["payment"]["available"] is True
    assert "us_bank_account" in view["payment"]["methods"]

    # Garbage tokens 404; amount over balance 409; junk amount 409.
    assert client.get("/i/not-a-real-token").status_code == 404
    assert (
        client.post(f"/i/{token}/checkout", json={"amount": "5000", "method": "card"}).status_code
        == 409
    )
    assert (
        client.post(f"/i/{token}/checkout", json={"amount": "abc", "method": "card"}).status_code
        == 409
    )

    # Partial ACH payment: $400 of $1000.
    checkout = client.post(
        f"/i/{token}/checkout", json={"amount": "400", "method": "us_bank_account"}
    ).json()
    assert checkout["url"].startswith("https://checkout.stripe.test/")
    db.expire_all()
    invoice = db.get(Invoice, invoice_id)
    assert invoice is not None and invoice.stripe_checkout_session_id is not None
    assert invoice.stripe_payment_intent_id is not None
    session_1, intent_1 = invoice.stripe_checkout_session_id, invoice.stripe_payment_intent_id

    receipts_before = len(QUEUE.receipts)
    _post_webhook(client, _checkout_completed_event(session_1, intent_1, 40_000))
    db.expire_all()
    invoice = db.get(Invoice, invoice_id)
    assert invoice is not None and invoice.status == "partial"
    payment = db.scalar(
        select(Payment).where(Payment.invoice_id == invoice_id, Payment.status == "succeeded")
    )
    assert payment is not None and payment.amount == Decimal("400.00")
    # Real economics from the (fake) balance transaction: 2.9% + $0.30
    # processing + $10 platform fee (2.5% of 400) = $21.90.
    assert payment.fee == Decimal("21.90")
    assert payment.net == Decimal("378.10")
    assert len(QUEUE.receipts) == receipts_before + 1

    # Public view reflects the partial payment.
    view = client.get(f"/i/{token}").json()
    assert view["status"] == "partial"
    assert view["amount_paid"] == "400.00"
    assert view["balance_due"] == "600.00"

    # A polite nudge can be queued while a balance is open.
    reminders_before = len(QUEUE.reminders)
    assert client.post(f"/invoices/{invoice_id}/remind").status_code == 200
    assert len(QUEUE.reminders) == reminders_before + 1

    # Card payment clears the remaining $600 → paid; second receipt queued.
    checkout = client.post(f"/i/{token}/checkout", json={"method": "card"}).json()
    db.expire_all()
    invoice = db.get(Invoice, invoice_id)
    assert invoice is not None
    session_2, intent_2 = invoice.stripe_checkout_session_id, invoice.stripe_payment_intent_id
    assert session_2 is not None and intent_2 is not None and session_2 != session_1
    _post_webhook(client, _checkout_completed_event(session_2, intent_2, 60_000))
    db.expire_all()
    invoice = db.get(Invoice, invoice_id)
    assert invoice is not None and invoice.status == "paid" and invoice.paid_at is not None
    assert len(QUEUE.receipts) == receipts_before + 2

    # Paid invoices can't be paid or nudged again.
    assert client.post(f"/i/{token}/checkout", json={"method": "card"}).status_code == 409
    assert client.post(f"/invoices/{invoice_id}/remind").status_code == 409

    # Manual partial refund: $200 back → settled 800 of 1000 → partial.
    refunded = client.post(f"/invoices/{invoice_id}/refund", json={"amount": "200"}).json()
    assert refunded["status"] == "partial"
    assert refunded["amount_paid"] == "800.00"
    assert any(Decimal(p["amount"]) == Decimal("-200.00") for p in refunded["payments"])
    assert STRIPE.refunds and STRIPE.refunds[-1]["amount"] == 20_000

    # Stripe's charge.refunded webhook for the SAME refund is a no-op…
    refund_id = str(STRIPE.refunds[-1]["id"])
    _post_webhook(
        client,
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "charge.refunded",
            "data": {
                "object": {
                    "id": f"ch_{uuid.uuid4().hex[:12]}",
                    "payment_intent": intent_2,
                    "amount_refunded": 20_000,
                    "refunds": {"data": [{"id": refund_id, "amount": 20_000}]},
                }
            },
        },
    )
    detail = client.get(f"/invoices/{invoice_id}").json()
    assert detail["amount_paid"] == "800.00"
    refund_rows = [p for p in detail["payments"] if p["status"] == "refunded"]
    assert len(refund_rows) == 1

    # …and refunding more than was collected is refused.
    assert (
        client.post(f"/invoices/{invoice_id}/refund", json={"amount": "5000"}).status_code == 409
    )


def test_invoice_delivery_reminder_and_receipt(client: TestClient, db: Session) -> None:
    """Worker-side delivery with fakes: PDF rendered + stored, pay-link email
    to the client, polite reminder, and a receipt after payment."""
    from fieldquote.integrations.messaging import FakeEmail, FakeSms
    from fieldquote.integrations.pdf import FakePdf
    from fieldquote.services import invoice_delivery, invoicing

    contact = client.post(
        "/clients", json={"name": "Sarah Nguyen", "email": "sarah@example.com"}
    ).json()
    job_id, _ = _signed_proposal(client)
    job = db.get(Job, uuid.UUID(job_id))
    assert job is not None
    job.client_id = uuid.UUID(str(contact["id"]))
    job.status = "won"
    db.commit()

    progress = client.post(
        f"/jobs/{job_id}/invoices", json={"kind": "progress", "amount": "500"}
    ).json()
    sent = client.post(f"/invoices/{progress['id']}/send").json()
    assert str(sent["id"]) in QUEUE.invoices_delivered

    invoice = db.get(Invoice, uuid.UUID(progress["id"]))
    assert invoice is not None

    pdf, email, sms = FakePdf(), FakeEmail(), FakeSms()
    invoice_delivery.deliver_invoice(db, invoice, STORAGE, pdf, email, sms)
    assert invoice.pdf_path and invoice.pdf_path.endswith(".pdf")
    assert len(pdf.rendered) == 1
    html = pdf.rendered[0]
    assert sent["number"] in html and "Balance due" in html
    assert len(email.sent) == 1
    assert email.sent[0].to == "sarah@example.com"
    assert f"/i/{sent['public_token']}" in email.sent[0].body

    reminder_email = FakeEmail()
    invoice_delivery.remind_client(db, invoice, reminder_email, FakeSms())
    assert len(reminder_email.sent) == 1
    assert "reminder" in (reminder_email.sent[0].subject or "").lower()

    payment = invoicing.apply_successful_payment(
        db,
        invoice,
        amount=Decimal("500.00"),
        fee=Decimal("14.80"),
        net=Decimal("485.20"),
        raw={"payment_intent": f"pi_{uuid.uuid4().hex[:12]}"},
        payment_intent_id=None,
    )
    db.commit()
    receipt_email = FakeEmail()
    invoice_delivery.send_receipt(db, payment, receipt_email)
    assert len(receipt_email.sent) == 1
    assert "$500.00" in receipt_email.sent[0].body
    assert "paid in full" in receipt_email.sent[0].body.lower()

    # Reminders are skipped once nothing is owed.
    quiet_email = FakeEmail()
    invoice_delivery.remind_client(db, invoice, quiet_email, FakeSms())
    assert quiet_email.sent == []
