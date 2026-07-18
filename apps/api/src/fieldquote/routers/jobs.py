import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.errors import ConflictError, NotFoundError
from fieldquote.core.tenancy import TenantContext, get_current_context
from fieldquote.domain.job_status import JOB_STATUSES, allowed_targets, can_transition
from fieldquote.domain.models import Client, Job
from fieldquote.services import audit

router = APIRouter(tags=["jobs"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]

JOB_TYPE_CODES = (
    "panel_upgrade", "ev_charger", "service_call", "circuits_outlets",
    "fixtures_fans", "remodel", "generator", "other",
)  # fmt: skip


class JobOut(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    job_type_code: str | None
    address: str | None
    client_id: uuid.UUID | None
    client_name: str | None
    allowed_transitions: list[str]
    created_at: datetime


class JobIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    client_id: uuid.UUID | None = None
    job_type_code: str | None = Field(default=None, pattern=f"^({'|'.join(JOB_TYPE_CODES)})$")
    address: str | None = Field(default=None, max_length=500)


class JobPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    client_id: uuid.UUID | None = None
    job_type_code: str | None = Field(default=None, pattern=f"^({'|'.join(JOB_TYPE_CODES)})$")
    address: str | None = Field(default=None, max_length=500)


class TransitionIn(BaseModel):
    to_status: str


def _out(job: Job, client_name: str | None) -> JobOut:
    return JobOut(
        id=job.id,
        title=job.title,
        status=job.status,
        job_type_code=job.job_type_code,
        address=job.address,
        client_id=job.client_id,
        client_name=client_name,
        allowed_transitions=sorted(allowed_targets(job.status)),
        created_at=job.created_at,
    )


def _get_owned(db: Session, ctx: TenantContext, job_id: uuid.UUID) -> Job:
    job = db.get(Job, job_id)
    if job is None or job.company_id != ctx.company.id:
        raise NotFoundError("Job not found.")
    return job


def _check_client(db: Session, ctx: TenantContext, client_id: uuid.UUID | None) -> None:
    if client_id is None:
        return
    client = db.get(Client, client_id)
    if client is None or client.company_id != ctx.company.id:
        raise NotFoundError("Client not found.")


@router.get("/jobs")
def list_jobs(
    ctx: Ctx,
    db: Db,
    status: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> list[JobOut]:
    stmt = select(Job, Client.name).outerjoin(Client, Job.client_id == Client.id)
    stmt = stmt.where(Job.company_id == ctx.company.id)
    if status:
        if status not in JOB_STATUSES:
            raise NotFoundError("Unknown status.")
        stmt = stmt.where(Job.status == status)
    stmt = stmt.order_by(Job.created_at.desc()).limit(limit)
    return [_out(job, client_name) for job, client_name in db.execute(stmt)]


@router.post("/jobs", status_code=201)
def create_job(body: JobIn, ctx: Ctx, db: Db) -> JobOut:
    _check_client(db, ctx, body.client_id)
    job = Job(company_id=ctx.company.id, created_by=ctx.user.id, **body.model_dump())
    db.add(job)
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="job",
        entity_id=job.id,
        action="create",
        after=body.model_dump(mode="json"),
    )
    db.commit()
    db.refresh(job)
    client_name = job.client.name if job.client else None
    return _out(job, client_name)


@router.get("/jobs/{job_id}")
def get_job(job_id: uuid.UUID, ctx: Ctx, db: Db) -> JobOut:
    job = _get_owned(db, ctx, job_id)
    return _out(job, job.client.name if job.client else None)


@router.patch("/jobs/{job_id}")
def update_job(job_id: uuid.UUID, patch: JobPatch, ctx: Ctx, db: Db) -> JobOut:
    job = _get_owned(db, ctx, job_id)
    changes = patch.model_dump(exclude_unset=True)
    if "client_id" in changes:
        _check_client(db, ctx, changes["client_id"])
    before = {k: str(getattr(job, k)) for k in changes}
    for key, value in changes.items():
        setattr(job, key, value)
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="job",
        entity_id=job.id,
        action="update",
        before=before,
        after={k: str(v) for k, v in changes.items()},
    )
    db.commit()
    db.refresh(job)
    return _out(job, job.client.name if job.client else None)


@router.post("/jobs/{job_id}/transition")
def transition_job(job_id: uuid.UUID, body: TransitionIn, ctx: Ctx, db: Db) -> JobOut:
    job = _get_owned(db, ctx, job_id)
    if body.to_status not in JOB_STATUSES:
        raise ConflictError(f"Unknown status '{body.to_status}'.")
    if not can_transition(job.status, body.to_status):
        raise ConflictError(
            f"Can't move this job from {job.status} to {body.to_status}.",
            details={"allowed": sorted(allowed_targets(job.status))},
        )
    before = job.status
    job.status = body.to_status
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="job",
        entity_id=job.id,
        action="status_transition",
        before={"status": before},
        after={"status": body.to_status},
    )
    db.commit()
    db.refresh(job)
    return _out(job, job.client.name if job.client else None)
