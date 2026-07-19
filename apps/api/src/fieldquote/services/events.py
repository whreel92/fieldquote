"""Realtime event publishing, behind an interface.

Supabase Realtime broadcast is the production transport (mobile subscribes to
the job channel); development logs events; tests capture them. Event names:
`generation.started`, `scope.partial`, `estimate.ready`,
`generation.failed`.
"""

import logging
from typing import Any, Protocol

import httpx

from fieldquote.core.config import get_settings

logger = logging.getLogger(__name__)


class EventBus(Protocol):
    def publish(self, channel: str, event: str, payload: dict[str, Any]) -> None: ...


class LogEventBus:
    """Default when Supabase isn't configured — events land in the log."""

    def publish(self, channel: str, event: str, payload: dict[str, Any]) -> None:
        logger.info("event", extra={"channel": channel, "event": event, "payload": payload})


class SupabaseRealtimeBus:
    """Broadcast via Supabase Realtime REST endpoint. Failures are logged and
    swallowed — realtime is a UX enhancement, never a correctness dependency."""

    def __init__(self, supabase_url: str, service_role_key: str) -> None:
        self._url = supabase_url.rstrip("/") + "/realtime/v1/api/broadcast"
        self._key = service_role_key

    def publish(self, channel: str, event: str, payload: dict[str, Any]) -> None:
        try:
            httpx.post(
                self._url,
                json={
                    "messages": [{"topic": channel, "event": event, "payload": payload}]
                },
                headers={"Authorization": f"Bearer {self._key}", "apikey": self._key},
                timeout=5,
            ).raise_for_status()
        except httpx.HTTPError:
            logger.warning(
                "realtime_publish_failed", extra={"channel": channel, "event": event}
            )


class FakeEventBus:
    def __init__(self) -> None:
        self.events: list[tuple[str, str, dict[str, Any]]] = []

    def publish(self, channel: str, event: str, payload: dict[str, Any]) -> None:
        self.events.append((channel, event, payload))


def get_event_bus() -> EventBus:
    settings = get_settings()
    if settings.supabase_url and settings.supabase_service_role_key:
        return SupabaseRealtimeBus(settings.supabase_url, settings.supabase_service_role_key)
    return LogEventBus()


def job_channel(job_id: object) -> str:
    return f"job:{job_id}"
