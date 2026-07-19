"""arq worker tasks. Retries with backoff come from arq; after max_tries the
generate task records a generation_failed estimate (dead-letter semantics —
the failure is visible to the contractor, never silently dropped)."""

import logging
import uuid
from typing import Any, ClassVar

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from fieldquote.ai.providers import get_providers
from fieldquote.ai.types import GenerationFailure
from fieldquote.core.config import get_settings
from fieldquote.integrations.storage import get_storage
from fieldquote.services.events import get_event_bus
from fieldquote.services.generation import record_failure, run_generation

logger = logging.getLogger(__name__)

MAX_TRIES = 3


async def generate_estimate(ctx: dict[str, Any], job_id: str) -> str:
    """Generate a draft estimate for a job. Provider/transient errors raise
    (arq retries); on the final try the failure is recorded as a
    generation_failed estimate row."""
    engine = create_engine(get_settings().database_url)
    event_bus = get_event_bus()
    job_uuid = uuid.UUID(job_id)
    final_try = ctx.get("job_try", 1) >= MAX_TRIES
    try:
        with Session(engine) as db:
            try:
                estimate = run_generation(
                    db, job_uuid, get_providers(), get_storage(), event_bus
                )
                return str(estimate.id)
            except GenerationFailure as failure:
                if not final_try:
                    raise
                record_failure(db, job_uuid, failure, event_bus)
                return "failed"
    finally:
        engine.dispose()


class WorkerSettings:
    functions: ClassVar[list[Any]] = [generate_estimate]
    max_tries = MAX_TRIES
    retry_delay = 5.0

    @staticmethod
    def redis_settings() -> Any:
        from arq.connections import RedisSettings

        return RedisSettings.from_dsn(get_settings().redis_url)
