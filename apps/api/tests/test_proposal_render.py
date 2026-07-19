"""Pure unit tests for proposal rendering, hashing, fees, and Stripe webhook
signature verification — no DB, no network."""

import json
import uuid
from decimal import Decimal

import pytest

from fieldquote.integrations.stripe import (
    FakeStripe,
    WebhookVerificationError,
    _verify_signature,
)
from fieldquote.services.proposal_render import (
    PLATFORM_DISCLAIMER,
    ProposalDocument,
    build_document,
    signature_hash,
)


class _Line:
    def __init__(self, position, description, line_type, total, qty="1", unit="ea",
                 confidence="known", included=True, note=None):
        self.position = position
        self.description = description
        self.line_type = line_type
        self.qty = Decimal(qty)
        self.unit = unit
        self.confidence = confidence
        self.editable_note = note
        self.totals = {"total": total, "included": included}


class _Estimate:
    def __init__(self, lines, total="1000", subtotal="920", tax="80"):
        self.scope_prose = "We will upgrade the panel."
        self.lines = lines
        self.totals = {"total": total, "subtotal": subtotal, "tax": tax}


class _Company:
    id = uuid.uuid4()
    name = "Reel Electric"
    logo_url = None
    license_number = "AZ-ROC-12345"
    phone = "480-555-0100"
    email = "will@reel.example"
    address = "Phoenix, AZ"


class _Client:
    name = "Sarah Chen"
    email = "sarah@example.com"
    address = "4112 E Cactus Rd"


class _Proposal:
    def __init__(self, config):
        self.config = config


def _doc(config=None):
    lines = [
        _Line(0, "200A panel upgrade", "standard", "800.00"),
        _Line(1, "Load calc", "allowance", "0.00", confidence="allowance",
              note="Confirm on site"),
        _Line(2, "Ground rod not visible", "verify", "0.00", confidence="verify"),
        _Line(3, "Recessed LED — Standard", "option_good", "200.00", included=True),
        _Line(4, "Recessed LED — Smart", "option_best", "400.00", included=False),
    ]
    return build_document(
        _Proposal(config or {"deposit": {"kind": "percent", "value": "25"}}),
        _Estimate(lines),
        _Company(),
        _Client(),
    )


def test_document_builds_groups_and_deposit() -> None:
    doc = _doc()
    assert doc.total == "1000.00"
    assert doc.deposit_amount == "250.00"  # 25% of 1000
    assert len(doc.lines) == 3  # options split out
    assert len(doc.option_groups) == 1
    tiers = doc.option_groups[0].tiers
    assert [t.tier for t in tiers] == ["good", "best"]
    assert doc.platform_disclaimer == PLATFORM_DISCLAIMER.format(company="Reel Electric")


def test_flat_deposit_capped_at_total() -> None:
    doc = _doc({"deposit": {"kind": "flat", "value": "99999"}})
    assert doc.deposit_amount == "1000.00"


def test_content_hash_is_deterministic_and_sensitive() -> None:
    a = _doc()
    b = _doc()
    assert a.content_hash() == b.content_hash()
    # canonical json is stable regardless of dict ordering
    assert a.canonical_json() == b.canonical_json()
    # a change to intro flips the hash
    c = _doc({"deposit": {"kind": "percent", "value": "25"}, "intro_message": "Hi"})
    assert c.content_hash() != a.content_hash()


def test_signature_hash_binds_content_signer_time() -> None:
    content = "a" * 64
    h1 = signature_hash(content, "Sarah Chen", "2026-07-18T10:00:00+00:00")
    h2 = signature_hash(content, "Sarah Chen", "2026-07-18T10:00:00+00:00")
    h3 = signature_hash(content, "Bob", "2026-07-18T10:00:00+00:00")
    assert h1 == h2 and h1 != h3
    assert len(h1) == 64


def test_document_roundtrips_through_json() -> None:
    doc = _doc()
    restored = ProposalDocument.model_validate(json.loads(doc.model_dump_json()))
    assert restored.content_hash() == doc.content_hash()


# ── Stripe webhook signature ─────────────────────────────────────────────────


def test_webhook_signature_roundtrip() -> None:
    stripe = FakeStripe("whsec_abc")
    payload = json.dumps({"id": "evt_1", "type": "checkout.session.completed"}).encode()
    header = stripe.sign(payload)
    event = stripe.verify_webhook(payload, header)
    assert event["id"] == "evt_1"


def test_webhook_rejects_tampered_payload() -> None:
    stripe = FakeStripe("whsec_abc")
    payload = b'{"id":"evt_1"}'
    header = stripe.sign(payload)
    with pytest.raises(WebhookVerificationError):
        stripe.verify_webhook(b'{"id":"evt_TAMPERED"}', header)


def test_webhook_rejects_wrong_secret() -> None:
    payload = b'{"id":"evt_1"}'
    header = FakeStripe("whsec_right").sign(payload)
    with pytest.raises(WebhookVerificationError):
        FakeStripe("whsec_wrong").verify_webhook(payload, header)


def test_webhook_rejects_old_timestamp() -> None:
    payload = b'{"id":"evt_1"}'
    header = FakeStripe("whsec_abc").sign(payload, timestamp=1)  # far in the past
    with pytest.raises(WebhookVerificationError):
        _verify_signature(payload, header, "whsec_abc", tolerance=300)


def test_webhook_rejects_malformed_header() -> None:
    with pytest.raises(WebhookVerificationError):
        _verify_signature(b"{}", "garbage", "whsec_abc")
