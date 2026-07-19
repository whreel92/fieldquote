"""Cost/latency instrumentation → PostHog when configured, structured logs
always. Never raises — analytics must not break generation."""

import logging
from typing import Any

import httpx

from fieldquote.core.config import get_settings

logger = logging.getLogger(__name__)

POSTHOG_URL = "https://us.i.posthog.com/capture/"


def _capture(event: str, properties: dict[str, Any]) -> None:
    logger.info("metric", extra={"metric_event": event, **properties})
    settings = get_settings()
    if not settings.posthog_key:
        return
    try:
        httpx.post(
            POSTHOG_URL,
            json={
                "api_key": settings.posthog_key,
                "event": event,
                "distinct_id": "api-server",
                "properties": properties,
            },
            timeout=3,
        )
    except httpx.HTTPError:
        logger.debug("posthog_capture_failed", extra={"event": event})


def record_provider_call(stage: str, provider: str, *, duration_s: float) -> None:
    _capture(
        "ai_provider_call",
        {"stage": stage, "provider": provider, "duration_s": round(duration_s, 3)},
    )


def record_payment_collected(
    *,
    invoice_id: str,
    kind: str,
    amount: str,
    fee: str | None,
    net: str | None,
    platform_fee: str | None,
) -> None:
    """The revenue line: every collected payment, with the platform take
    reported separately from processing fees."""
    _capture(
        "payment_collected",
        {
            "invoice_id": invoice_id,
            "invoice_kind": kind,
            "amount": amount,
            "fee": fee,
            "net": net,
            "platform_fee": platform_fee,
        },
    )


def record_generation(
    *, job_id: str, duration_s: float, assemblies: int, outside_scope: bool
) -> None:
    _capture(
        "estimate_generated",
        {
            "job_id": job_id,
            "duration_s": round(duration_s, 3),
            "assembly_count": assemblies,
            "outside_scope": outside_scope,
        },
    )
