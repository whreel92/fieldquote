"""Email (Resend) and SMS (Twilio) senders behind interfaces.

Both are blocked on human dependencies (Resend domain, Twilio A2P 10DLC —
§0.1.10). SMS stays behind `sms_enabled` until the campaign is approved.
Unconfigured senders log instead of sending; tests use the fakes and assert
on captured messages. Send failures are surfaced to the caller, never
silently swallowed (Appendix B)."""

import logging
from dataclasses import dataclass, field
from typing import Protocol

import httpx

from fieldquote.core.config import get_settings

logger = logging.getLogger(__name__)


class MessagingError(Exception):
    pass


@dataclass
class SentMessage:
    channel: str
    to: str
    subject: str | None
    body: str


class EmailSender(Protocol):
    def send(self, *, to: str, subject: str, html: str, reply_to: str | None = None) -> None: ...


class SmsSender(Protocol):
    def send(self, *, to: str, body: str) -> None: ...


class ResendEmail:
    def __init__(self, api_key: str, from_address: str = "proposals@fieldquote.app") -> None:
        self._key = api_key
        self._from = from_address

    def send(self, *, to: str, subject: str, html: str, reply_to: str | None = None) -> None:
        body: dict[str, object] = {
            "from": self._from,
            "to": [to],
            "subject": subject,
            "html": html,
        }
        if reply_to:
            body["reply_to"] = reply_to
        try:
            response = httpx.post(
                "https://api.resend.com/emails",
                json=body,
                headers={"Authorization": f"Bearer {self._key}"},
                timeout=15,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise MessagingError(f"Resend send failed: {exc}") from exc


class TwilioSms:
    def __init__(self, account_sid: str, auth_token: str, messaging_service_sid: str) -> None:
        self._sid = account_sid
        self._token = auth_token
        self._service = messaging_service_sid

    def send(self, *, to: str, body: str) -> None:
        try:
            response = httpx.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{self._sid}/Messages.json",
                data={"To": to, "MessagingServiceSid": self._service, "Body": body},
                auth=(self._sid, self._token),
                timeout=15,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise MessagingError(f"Twilio send failed: {exc}") from exc


class LogEmail:
    def send(self, *, to: str, subject: str, html: str, reply_to: str | None = None) -> None:
        logger.info("email_stub", extra={"to": to, "subject": subject})


class LogSms:
    def send(self, *, to: str, body: str) -> None:
        logger.info("sms_stub", extra={"to": to})


@dataclass
class FakeEmail:
    sent: list[SentMessage] = field(default_factory=list)

    def send(self, *, to: str, subject: str, html: str, reply_to: str | None = None) -> None:
        self.sent.append(SentMessage("email", to, subject, html))


@dataclass
class FakeSms:
    sent: list[SentMessage] = field(default_factory=list)

    def send(self, *, to: str, body: str) -> None:
        self.sent.append(SentMessage("sms", to, None, body))


def get_email_sender() -> EmailSender:
    settings = get_settings()
    if settings.resend_api_key:
        return ResendEmail(settings.resend_api_key)
    return LogEmail()


def get_sms_sender() -> SmsSender:
    settings = get_settings()
    if (
        settings.sms_enabled
        and settings.twilio_account_sid
        and settings.twilio_auth_token
        and settings.twilio_messaging_service_sid
    ):
        return TwilioSms(
            settings.twilio_account_sid,
            settings.twilio_auth_token,
            settings.twilio_messaging_service_sid,
        )
    return LogSms()


def sms_enabled() -> bool:
    settings = get_settings()
    return bool(
        settings.sms_enabled
        and settings.twilio_account_sid
        and settings.twilio_messaging_service_sid
    )
