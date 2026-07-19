"""Stripe Connect + Checkout behind an interface (CLAUDE.md §0.1.10).

Real calls go over the REST API with httpx (no SDK dependency); webhook
signature verification is implemented directly (Stripe's scheme is a plain
HMAC-SHA256 over `timestamp.payload`), which keeps it unit-testable without
network or the SDK. `FakeStripe` backs tests and unconfigured dev.

Money crosses a trust boundary here, so every method is explicit and the
platform application fee is always passed through — never defaulted silently.
"""

import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx

from fieldquote.core.config import get_settings

STRIPE_API = "https://api.stripe.com/v1"


class StripeError(Exception):
    pass


class WebhookVerificationError(StripeError):
    pass


@dataclass(frozen=True)
class ConnectAccount:
    account_id: str
    charges_enabled: bool
    details_submitted: bool
    payouts_enabled: bool


@dataclass(frozen=True)
class CheckoutSession:
    session_id: str
    url: str
    payment_intent_id: str | None


class StripeGateway(Protocol):
    def create_connect_account(self, *, company_id: str, email: str | None) -> str: ...

    def create_account_link(
        self, account_id: str, *, refresh_url: str, return_url: str
    ) -> str: ...

    def get_account(self, account_id: str) -> ConnectAccount: ...

    def create_deposit_checkout(
        self,
        *,
        account_id: str,
        amount_cents: int,
        application_fee_cents: int,
        currency: str,
        success_url: str,
        cancel_url: str,
        description: str,
        metadata: dict[str, str],
    ) -> CheckoutSession: ...

    def verify_webhook(self, payload: bytes, sig_header: str) -> dict[str, Any]: ...


def _verify_signature(payload: bytes, sig_header: str, secret: str, tolerance: int = 300) -> None:
    """Stripe signature scheme: header is `t=...,v1=...`; the signed message is
    `{t}.{payload}`, HMAC-SHA256 with the endpoint secret."""
    parts = dict(
        item.split("=", 1) for item in sig_header.split(",") if "=" in item
    )
    timestamp = parts.get("t")
    signature = parts.get("v1")
    if not timestamp or not signature:
        raise WebhookVerificationError("Malformed Stripe-Signature header.")
    signed = f"{timestamp}.{payload.decode('utf-8')}".encode()
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise WebhookVerificationError("Stripe signature mismatch.")
    # Replay window (clock is provided by the caller's environment; tests set t).
    try:
        age = int(time.time()) - int(timestamp)
    except ValueError as exc:
        raise WebhookVerificationError("Bad timestamp.") from exc
    if age > tolerance:
        raise WebhookVerificationError("Webhook timestamp outside tolerance.")


class HttpStripeGateway:
    def __init__(self, secret_key: str, webhook_secret: str) -> None:
        self._key = secret_key
        self._webhook_secret = webhook_secret

    def _post(
        self, path: str, data: dict[str, Any], *, account: str | None = None
    ) -> dict[str, Any]:
        headers = {} if account is None else {"Stripe-Account": account}
        try:
            response = httpx.post(
                f"{STRIPE_API}{path}",
                content=urlencode(data, doseq=True),
                headers={**headers, "Content-Type": "application/x-www-form-urlencoded"},
                auth=(self._key, ""),
                timeout=20,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise StripeError(f"Stripe request failed: {exc}") from exc
        return dict(response.json())

    def _get(self, path: str) -> dict[str, Any]:
        try:
            response = httpx.get(
                f"{STRIPE_API}{path}", auth=(self._key, ""), timeout=20
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise StripeError(f"Stripe request failed: {exc}") from exc
        return dict(response.json())

    def create_connect_account(self, *, company_id: str, email: str | None) -> str:
        data: dict[str, Any] = {
            "type": "express",
            "capabilities[card_payments][requested]": "true",
            "capabilities[transfers][requested]": "true",
            "metadata[company_id]": company_id,
        }
        if email:
            data["email"] = email
        return str(self._post("/accounts", data)["id"])

    def create_account_link(
        self, account_id: str, *, refresh_url: str, return_url: str
    ) -> str:
        data = {
            "account": account_id,
            "refresh_url": refresh_url,
            "return_url": return_url,
            "type": "account_onboarding",
        }
        return str(self._post("/account_links", data)["url"])

    def get_account(self, account_id: str) -> ConnectAccount:
        payload = self._get(f"/accounts/{account_id}")
        return ConnectAccount(
            account_id=account_id,
            charges_enabled=bool(payload.get("charges_enabled")),
            details_submitted=bool(payload.get("details_submitted")),
            payouts_enabled=bool(payload.get("payouts_enabled")),
        )

    def create_deposit_checkout(
        self,
        *,
        account_id: str,
        amount_cents: int,
        application_fee_cents: int,
        currency: str,
        success_url: str,
        cancel_url: str,
        description: str,
        metadata: dict[str, str],
    ) -> CheckoutSession:
        data: dict[str, Any] = {
            "mode": "payment",
            "success_url": success_url,
            "cancel_url": cancel_url,
            "line_items[0][price_data][currency]": currency,
            "line_items[0][price_data][product_data][name]": description,
            "line_items[0][price_data][unit_amount]": amount_cents,
            "line_items[0][quantity]": 1,
            "payment_intent_data[application_fee_amount]": application_fee_cents,
        }
        for key, value in metadata.items():
            data[f"metadata[{key}]"] = value
            data[f"payment_intent_data[metadata][{key}]"] = value
        session = self._post("/checkout/sessions", data, account=account_id)
        return CheckoutSession(
            session_id=str(session["id"]),
            url=str(session["url"]),
            payment_intent_id=session.get("payment_intent"),
        )

    def verify_webhook(self, payload: bytes, sig_header: str) -> dict[str, Any]:
        _verify_signature(payload, sig_header, self._webhook_secret)
        return dict(json.loads(payload))


class FakeStripe:
    """Deterministic in-memory Stripe for tests. `webhook_secret` enables
    signing test events with `sign(payload)`."""

    def __init__(self, webhook_secret: str = "whsec_test") -> None:
        self.webhook_secret = webhook_secret
        self.accounts: dict[str, ConnectAccount] = {}
        self.sessions: list[CheckoutSession] = []

    def _next(self, prefix: str) -> str:
        # uuid suffix so ids are globally unique — Stripe ids are, and it keeps
        # a persistent test DB from colliding across runs.
        return f"{prefix}_{uuid.uuid4().hex[:16]}"

    def create_connect_account(self, *, company_id: str, email: str | None) -> str:
        account_id = self._next("acct")
        self.accounts[account_id] = ConnectAccount(account_id, False, False, False)
        return account_id

    def create_account_link(
        self, account_id: str, *, refresh_url: str, return_url: str
    ) -> str:
        return f"https://connect.stripe.test/setup/{account_id}"

    def mark_account_ready(self, account_id: str) -> None:
        self.accounts[account_id] = ConnectAccount(account_id, True, True, True)

    def get_account(self, account_id: str) -> ConnectAccount:
        return self.accounts.get(account_id, ConnectAccount(account_id, False, False, False))

    def create_deposit_checkout(
        self,
        *,
        account_id: str,
        amount_cents: int,
        application_fee_cents: int,
        currency: str,
        success_url: str,
        cancel_url: str,
        description: str,
        metadata: dict[str, str],
    ) -> CheckoutSession:
        session_id = self._next("cs")
        session = CheckoutSession(
            session_id=session_id,
            url=f"https://checkout.stripe.test/{session_id}",
            payment_intent_id=self._next("pi"),
        )
        self.sessions.append(session)
        return session

    def sign(self, payload: bytes, timestamp: int | None = None) -> str:
        ts = timestamp if timestamp is not None else int(time.time())
        signed = f"{ts}.{payload.decode('utf-8')}".encode()
        signature = hmac.new(self.webhook_secret.encode(), signed, hashlib.sha256).hexdigest()
        return f"t={ts},v1={signature}"

    def verify_webhook(self, payload: bytes, sig_header: str) -> dict[str, Any]:
        _verify_signature(payload, sig_header, self.webhook_secret)
        return dict(json.loads(payload))


def get_stripe() -> StripeGateway:
    settings = get_settings()
    if settings.stripe_secret_key and settings.stripe_webhook_secret:
        return HttpStripeGateway(settings.stripe_secret_key, settings.stripe_webhook_secret)
    # Unconfigured: a Fake so dev/staging don't crash; real keys gate live money.
    return FakeStripe()


def stripe_configured() -> bool:
    settings = get_settings()
    return bool(settings.stripe_secret_key and settings.stripe_webhook_secret)
