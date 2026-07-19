"""Capture registration + signed uploads.

Flow (mobile, Phase 4): POST a capture record → PUT the file to the signed
URL → POST /complete. Files live in private buckets; paths are namespaced by
company/job so signed URLs are the only access path."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.errors import NotFoundError
from fieldquote.core.tenancy import TenantContext, get_current_context
from fieldquote.domain.models import Capture, Job
from fieldquote.integrations.storage import StorageService, get_storage

router = APIRouter(tags=["captures"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]
Storage = Annotated[StorageService, Depends(get_storage)]

BUCKETS = {"photo": "job-photos", "audio": "job-audio"}
EXTENSIONS = {"photo": "jpg", "audio": "m4a"}


class CaptureIn(BaseModel):
    kind: Literal["photo", "audio"]
    duration_s: Decimal | None = Field(default=None, ge=0)
    exif: dict[str, Any] | None = None


class CaptureOut(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    kind: str
    storage_path: str
    upload_state: str
    duration_s: Decimal | None
    has_transcript: bool
    has_vision_findings: bool
    created_at: datetime


class CaptureCreated(BaseModel):
    capture: CaptureOut
    upload_url: str
    upload_token: str


def _out(capture: Capture) -> CaptureOut:
    return CaptureOut(
        id=capture.id,
        job_id=capture.job_id,
        kind=capture.kind,
        storage_path=capture.storage_path,
        upload_state=capture.upload_state,
        duration_s=capture.duration_s,
        has_transcript=capture.transcript is not None,
        has_vision_findings=capture.vision_findings is not None,
        created_at=capture.created_at,
    )


def _get_job(db: Session, ctx: TenantContext, job_id: uuid.UUID) -> Job:
    job = db.get(Job, job_id)
    if job is None or job.company_id != ctx.company.id:
        raise NotFoundError("Job not found.")
    return job


@router.post("/jobs/{job_id}/captures", status_code=201)
def create_capture(
    job_id: uuid.UUID, body: CaptureIn, ctx: Ctx, db: Db, storage: Storage
) -> CaptureCreated:
    job = _get_job(db, ctx, job_id)
    capture_id = uuid.uuid4()
    path = f"{ctx.company.id}/{job.id}/{capture_id}.{EXTENSIONS[body.kind]}"
    capture = Capture(
        id=capture_id,
        company_id=ctx.company.id,
        job_id=job.id,
        kind=body.kind,
        storage_path=path,
        duration_s=body.duration_s,
        exif=body.exif,
        upload_state="pending",
    )
    db.add(capture)
    db.commit()
    db.refresh(capture)
    signed = storage.create_signed_upload(BUCKETS[body.kind], path)
    return CaptureCreated(capture=_out(capture), upload_url=signed.url, upload_token=signed.token)


@router.post("/captures/{capture_id}/complete")
def complete_capture(capture_id: uuid.UUID, ctx: Ctx, db: Db) -> CaptureOut:
    capture = db.get(Capture, capture_id)
    if capture is None or capture.company_id != ctx.company.id:
        raise NotFoundError("Capture not found.")
    capture.upload_state = "uploaded"
    db.commit()
    db.refresh(capture)
    return _out(capture)


@router.get("/jobs/{job_id}/captures")
def list_captures(job_id: uuid.UUID, ctx: Ctx, db: Db) -> list[CaptureOut]:
    _get_job(db, ctx, job_id)
    rows = db.scalars(
        select(Capture).where(Capture.job_id == job_id).order_by(Capture.created_at)
    )
    return [_out(row) for row in rows]
