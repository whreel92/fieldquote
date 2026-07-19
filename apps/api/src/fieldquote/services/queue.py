"""Job queue behind an interface: arq/Redis in real deployments, FakeQueue in
tests. The API never runs generation in-request."""

from typing import Any, Protocol

from fieldquote.core.config import get_settings


class Queue(Protocol):
    async def enqueue_generate(self, job_id: str) -> None: ...

    async def enqueue_deliver_proposal(self, proposal_id: str) -> None: ...


class ArqQueue:
    def __init__(self, redis_url: str) -> None:
        self._redis_url = redis_url
        self._pool: Any = None

    async def _get_pool(self) -> Any:
        if self._pool is None:
            from arq import create_pool
            from arq.connections import RedisSettings

            self._pool = await create_pool(RedisSettings.from_dsn(self._redis_url))
        return self._pool

    async def enqueue_generate(self, job_id: str) -> None:
        pool = await self._get_pool()
        await pool.enqueue_job("generate_estimate", job_id)

    async def enqueue_deliver_proposal(self, proposal_id: str) -> None:
        pool = await self._get_pool()
        await pool.enqueue_job("deliver_proposal", proposal_id)


class FakeQueue:
    def __init__(self) -> None:
        self.enqueued: list[str] = []
        self.delivered: list[str] = []

    async def enqueue_generate(self, job_id: str) -> None:
        self.enqueued.append(job_id)

    async def enqueue_deliver_proposal(self, proposal_id: str) -> None:
        self.delivered.append(proposal_id)


_queue: Queue | None = None


def get_queue() -> Queue:
    global _queue
    if _queue is None:
        _queue = ArqQueue(get_settings().redis_url)
    return _queue
