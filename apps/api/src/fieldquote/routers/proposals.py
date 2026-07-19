"""Proposal composer + send (contractor-facing, authenticated).

The single entry point estimate → proposal enforces approval (§0.1.2). Draft
proposals carry an editable composer `config`; sending freezes an immutable
snapshot (§0.1.3). Public signing/paying lives in routers/public.py.
"""

import secrets
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.errors import ConflictError
from fieldquote.core.tenancy import TenantContext, get_current_context, require_role
from fieldquote.domain.models import Estimate, Proposal, Signature
from fieldquote.integrations.storage import StorageService, get_storage
from fieldquote.services import audit
from fieldquote.services import proposals as proposal_service
from fieldquote.services.estimate_editing import get_owned_estimate
from fieldquote.services.queue import Queue, get_queue

router = APIRouter(tags=["proposals"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]
Storage = Annotated[StorageService, Depends(get_storage)]
Q = Annotated[Queue, Depends(get_queue)]


class DepositConfig(BaseModel):
    kind: Literal["percent", "flat"] = "percent"
    value: Decimal = Field(default=Decimal(25), ge=0)


class ProposalConfig(BaseModel):
    title: str = "Project proposal"
    cover_photo_url: str | None = None
    intro_message: str = ""
    inclusions: list[str] = Field(default_factory=list)
    exclusions: list[str] = Field(default_factory=list)
    deposit: DepositConfig = DepositConfig()
    validity_days: int = Field(default=30, ge=1, le=365)
    company_terms: str = ""


class ProposalOut(BaseModel):
    id: uuid.UUID
    estimate_id: uuid.UUID
    version: int
    status: str
    public_token: str
    content_hash: str | None
    config: dict[str, Any]
    sent_at: datetime | None
    first_viewed_at: datetime | None
    view_count: int
    expires_at: datetime | None


class ProposalWithDocument(ProposalOut):
    document: dict[str, Any]
    signature: dict[str, Any] | None


def _out(proposal: Proposal) -> ProposalOut:
    return ProposalOut(
        id=proposal.id,
        estimate_id=proposal.estimate_id,
        version=proposal.version,
        status=proposal.status,
        public_token=proposal.public_token,
        content_hash=proposal.content_hash,
        config=proposal.config or {},
        sent_at=proposal.sent_at,
        first_viewed_at=proposal.first_viewed_at,
        view_count=proposal.view_count,
        expires_at=proposal.expires_at,
    )


def _with_document(db: Session, proposal: Proposal) -> ProposalWithDocument:
    if proposal.snapshot:
        document = proposal_service.frozen_document(proposal).model_dump()
    else:
        document = proposal_service.preview_document(db, proposal).model_dump()
    signature = db.scalar(
        select(Signature).where(Signature.proposal_id == proposal.id)
    )
    return ProposalWithDocument(
        **_out(proposal).model_dump(),
        document=document,
        signature=(
            {
                "signer_name": signature.signer_name,
                "signed_at": signature.signed_at.isoformat(),
                "signature_hash": signature.signature_hash,
            }
            if signature
            else None
        ),
    )


@router.post("/estimates/{estimate_id}/proposals", status_code=201)
def create_proposal(estimate_id: uuid.UUID, ctx: Ctx, db: Db) -> ProposalOut:
    require_role(ctx, "owner", "admin", "office")
    estimate = get_owned_estimate(db, ctx.company.id, estimate_id)
    if estimate.status != "approved":
        # THE legal control (tested by test_approval_control.py).
        raise ConflictError(
            "Review and approve this estimate before creating a proposal.",
            details={"code": "approval_required", "status": estimate.status},
        )
    version = (
        db.scalar(
            select(Proposal.version)
            .where(Proposal.estimate_id == estimate.id)
            .order_by(Proposal.version.desc())
            .limit(1)
        )
        or 0
    ) + 1
    proposal = Proposal(
        company_id=ctx.company.id,
        estimate_id=estimate.id,
        version=version,
        status="draft",
        public_token=secrets.token_urlsafe(24),
        config=ProposalConfig().model_dump(mode="json"),
    )
    db.add(proposal)
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="proposal",
        entity_id=proposal.id,
        action="create",
        after={"estimate_id": str(estimate.id), "version": version},
    )
    db.commit()
    db.refresh(proposal)
    return _out(proposal)


@router.get("/estimates/{estimate_id}/proposals")
def list_proposals(estimate_id: uuid.UUID, ctx: Ctx, db: Db) -> list[ProposalOut]:
    get_owned_estimate(db, ctx.company.id, estimate_id)
    rows = db.scalars(
        select(Proposal)
        .where(Proposal.estimate_id == estimate_id)
        .order_by(Proposal.version.desc())
    )
    return [_out(row) for row in rows]


@router.get("/proposals/{proposal_id}")
def get_proposal(proposal_id: uuid.UUID, ctx: Ctx, db: Db) -> ProposalWithDocument:
    proposal = proposal_service.get_owned_proposal(db, ctx.company.id, proposal_id)
    return _with_document(db, proposal)


@router.patch("/proposals/{proposal_id}")
def update_config(
    proposal_id: uuid.UUID, config: ProposalConfig, ctx: Ctx, db: Db
) -> ProposalWithDocument:
    proposal = proposal_service.get_owned_proposal(db, ctx.company.id, proposal_id)
    if proposal.status != "draft":
        raise ConflictError(
            "A sent proposal can't be edited. Create a new version.",
            details={"code": "already_sent"},
        )
    proposal.config = config.model_dump(mode="json")
    db.commit()
    db.refresh(proposal)
    return _with_document(db, proposal)


@router.post("/proposals/{proposal_id}/send")
async def send(
    proposal_id: uuid.UUID, ctx: Ctx, db: Db, storage: Storage, queue: Q
) -> ProposalWithDocument:
    require_role(ctx, "owner", "admin", "office")
    proposal = proposal_service.get_owned_proposal(db, ctx.company.id, proposal_id)
    proposal_service.send_proposal(db, proposal, ctx.user.id, storage)
    db.commit()
    db.refresh(proposal)
    # PDF render + client email/SMS happen in the worker (§Phase 6.3/6.4).
    await queue.enqueue_deliver_proposal(str(proposal.id))
    return _with_document(db, proposal)


@router.post("/estimates/{estimate_id}/duplicate-proposal", status_code=201)
def new_version(estimate_id: uuid.UUID, ctx: Ctx, db: Db) -> ProposalOut:
    """Fork a fresh draft proposal (e.g. after editing) copying the last
    config. Sent proposals are never mutated — this is how they change."""
    require_role(ctx, "owner", "admin", "office")
    estimate = get_owned_estimate(db, ctx.company.id, estimate_id)
    latest = db.scalar(
        select(Proposal)
        .where(Proposal.estimate_id == estimate.id)
        .order_by(Proposal.version.desc())
        .limit(1)
    )
    config = latest.config if latest else ProposalConfig().model_dump(mode="json")
    version = (latest.version if latest else 0) + 1
    proposal = Proposal(
        company_id=ctx.company.id,
        estimate_id=estimate.id,
        version=version,
        status="draft",
        public_token=secrets.token_urlsafe(24),
        config=config,
    )
    db.add(proposal)
    db.commit()
    db.refresh(proposal)
    return _out(proposal)


@router.get("/jobs/{job_id}/proposals")
def list_job_proposals(job_id: uuid.UUID, ctx: Ctx, db: Db) -> list[ProposalOut]:
    rows = db.scalars(
        select(Proposal)
        .join(Estimate, Proposal.estimate_id == Estimate.id)
        .where(Estimate.job_id == job_id, Proposal.company_id == ctx.company.id)
        .order_by(Proposal.sent_at.desc().nullslast(), Proposal.version.desc())
    )
    return [_out(row) for row in rows]
