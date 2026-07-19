"""Estimate read endpoints + generation trigger.

Phase 3 scope: list/detail + queue a generation. Editing and the approval
flow are Phase 5 — note there is deliberately NO send/approve endpoint here,
and estimates are only ever created as drafts (§0.1.2)."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from fieldquote.core.db import get_db
from fieldquote.core.errors import ConflictError, NotFoundError
from fieldquote.core.tenancy import TenantContext, get_current_context
from fieldquote.domain.models import Capture, Estimate, Job
from fieldquote.services import audit
from fieldquote.services.queue import Queue, get_queue

router = APIRouter(tags=["estimates"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]
Q = Annotated[Queue, Depends(get_queue)]


class EstimateSummary(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    version: int
    status: str
    source: str
    totals: dict[str, Any] | None
    created_at: datetime


class EstimateLineOut(BaseModel):
    id: uuid.UUID
    position: int
    assembly_code: str | None
    description: str
    qty: Decimal
    unit: str | None
    material_cost: Decimal | None
    labor_hours: Decimal | None
    labor_rate: Decimal | None
    line_type: str
    price_source: str
    confidence: str
    editable_note: str | None
    totals: dict[str, Any] | None


class EstimateDetail(EstimateSummary):
    scope_prose: str | None
    ai_output: dict[str, Any] | None
    lines: list[EstimateLineOut]


class GenerateQueued(BaseModel):
    status: str = "queued"
    job_id: uuid.UUID


def _get_job(db: Session, ctx: TenantContext, job_id: uuid.UUID) -> Job:
    job = db.get(Job, job_id)
    if job is None or job.company_id != ctx.company.id:
        raise NotFoundError("Job not found.")
    return job


@router.post("/jobs/{job_id}/estimates/generate", status_code=202)
async def generate(job_id: uuid.UUID, ctx: Ctx, db: Db, queue: Q) -> GenerateQueued:
    job = _get_job(db, ctx, job_id)
    uploaded = db.scalar(
        select(Capture.id)
        .where(Capture.job_id == job.id, Capture.upload_state == "uploaded")
        .limit(1)
    )
    if uploaded is None:
        raise ConflictError(
            "Add at least one synced photo or voice note before generating an estimate."
        )
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="estimate",
        entity_id=job.id,
        action="generation_queued",
        after={"job_id": str(job.id)},
    )
    db.commit()
    await queue.enqueue_generate(str(job.id))
    return GenerateQueued(job_id=job.id)


@router.get("/jobs/{job_id}/estimates")
def list_estimates(job_id: uuid.UUID, ctx: Ctx, db: Db) -> list[EstimateSummary]:
    _get_job(db, ctx, job_id)
    rows = db.scalars(
        select(Estimate).where(Estimate.job_id == job_id).order_by(Estimate.version.desc())
    )
    return [EstimateSummary.model_validate(row, from_attributes=True) for row in rows]


@router.get("/estimates/{estimate_id}")
def get_estimate(estimate_id: uuid.UUID, ctx: Ctx, db: Db) -> EstimateDetail:
    estimate = db.scalar(
        select(Estimate)
        .options(selectinload(Estimate.lines))
        .where(Estimate.id == estimate_id)
    )
    if estimate is None or estimate.company_id != ctx.company.id:
        raise NotFoundError("Estimate not found.")
    return EstimateDetail(
        id=estimate.id,
        job_id=estimate.job_id,
        version=estimate.version,
        status=estimate.status,
        source=estimate.source,
        totals=estimate.totals,
        created_at=estimate.created_at,
        scope_prose=estimate.scope_prose,
        ai_output=estimate.ai_output,
        lines=[
            EstimateLineOut.model_validate(line, from_attributes=True)
            for line in estimate.lines
        ],
    )
