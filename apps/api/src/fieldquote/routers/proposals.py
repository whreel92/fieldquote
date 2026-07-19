"""Proposal creation — Phase 5 ships ONLY the legal control (§0.1.2/§Phase 5.7):

    There is no code path that turns an estimate into anything sendable
    unless the estimate is APPROVED. This is the single entry point from
    estimate → proposal, and it refuses drafts. Phase 6 builds the composer,
    hosted page, and send channels on top of this gate — never around it.
"""

import secrets
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.errors import ConflictError
from fieldquote.core.tenancy import TenantContext, get_current_context, require_role
from fieldquote.domain.models import Proposal
from fieldquote.services import audit
from fieldquote.services.estimate_editing import get_owned_estimate

router = APIRouter(tags=["proposals"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]


class ProposalOut(BaseModel):
    id: uuid.UUID
    estimate_id: uuid.UUID
    version: int
    status: str
    public_token: str
    created_at: datetime | None = None


@router.post("/estimates/{estimate_id}/proposals", status_code=201)
def create_proposal(estimate_id: uuid.UUID, ctx: Ctx, db: Db) -> ProposalOut:
    require_role(ctx, "owner", "admin", "office")
    estimate = get_owned_estimate(db, ctx.company.id, estimate_id)
    if estimate.status != "approved":
        # THE legal control. Do not weaken. Tested by
        # tests/test_approval_control.py::test_draft_estimate_cannot_become_proposal
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
    return ProposalOut(
        id=proposal.id,
        estimate_id=proposal.estimate_id,
        version=proposal.version,
        status=proposal.status,
        public_token=proposal.public_token,
    )
