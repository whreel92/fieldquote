"""Proposal lifecycle: send (freeze + snapshot), view tracking, sign, decline.

Immutability (§0.1.3): sending computes the document once, hashes it, stores
the frozen snapshot + content_hash + HTML, and locks the estimate. Any later
edit forks a new proposal version — a sent proposal is never mutated. Signing
binds a signature to the frozen content_hash; a signed proposal locks its
estimate version.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from fieldquote.core.errors import ConflictError, NotFoundError
from fieldquote.domain.models import Client, Company, Estimate, Job, Proposal, Signature
from fieldquote.integrations.storage import StorageService
from fieldquote.services import audit
from fieldquote.services.proposal_html import render_html
from fieldquote.services.proposal_render import (
    ProposalDocument,
    build_document,
    signature_hash,
)

DOCUMENTS_BUCKET = "documents"

SENDABLE_FROM = {"draft"}
# Once here the proposal is terminal or awaiting the client — no re-send.
TERMINAL_STATUSES = {"signed", "declined", "expired"}


def _load_context(
    db: Session, proposal: Proposal
) -> tuple[Estimate, Company, Client | None, Job]:
    estimate = db.scalar(
        select(Estimate)
        .options(selectinload(Estimate.lines))
        .where(Estimate.id == proposal.estimate_id)
    )
    if estimate is None:
        raise NotFoundError("Estimate not found.")
    company = db.get(Company, proposal.company_id)
    job = db.get(Job, estimate.job_id)
    if company is None or job is None:
        raise NotFoundError("Proposal context missing.")
    client = db.get(Client, job.client_id) if job.client_id else None
    return estimate, company, client, job


def preview_document(db: Session, proposal: Proposal) -> ProposalDocument:
    """Live document for a draft (composer preview). Sent proposals return
    their frozen snapshot instead."""
    estimate, company, client, _ = _load_context(db, proposal)
    return build_document(proposal, estimate, company, client)


def send_proposal(
    db: Session,
    proposal: Proposal,
    actor_id: uuid.UUID,
    storage: StorageService,
) -> ProposalDocument:
    if proposal.status not in SENDABLE_FROM:
        raise ConflictError(
            "This proposal has already been sent.",
            details={"code": "already_sent", "status": proposal.status},
        )
    estimate, company, client, _ = _load_context(db, proposal)
    if estimate.status != "approved":
        # Defense in depth: the estimate must be approved (§0.1.2). The proposal
        # could only be created from an approved estimate, but a fork could have
        # changed things — re-check at the moment of send.
        raise ConflictError(
            "The estimate must be approved before sending.",
            details={"code": "approval_required"},
        )

    document = build_document(proposal, estimate, company, client)
    content_hash = document.content_hash()
    html = render_html(document)
    html_path = f"{company.id}/{proposal.id}/proposal-{proposal.version}.html"
    storage.upload(DOCUMENTS_BUCKET, html_path, html.encode("utf-8"), "text/html")

    now = datetime.now(tz=UTC)
    proposal.snapshot = document.model_dump()
    proposal.content_hash = content_hash
    proposal.html_snapshot_path = html_path
    proposal.terms_version = document.terms_version
    proposal.status = "sent"
    proposal.sent_at = now
    proposal.expires_at = now + timedelta(days=document.validity_days)

    audit.record(
        db,
        company_id=company.id,
        actor_id=actor_id,
        entity="proposal",
        entity_id=proposal.id,
        action="send",
        after={"content_hash": content_hash, "version": proposal.version},
    )
    return document


def frozen_document(proposal: Proposal) -> ProposalDocument:
    if not proposal.snapshot:
        raise ConflictError("This proposal has not been sent yet.")
    return ProposalDocument.model_validate(proposal.snapshot)


def record_view(db: Session, proposal: Proposal) -> None:
    """Public page view — advances sent → viewed, counts views. Idempotent per
    render is not required; each load counts (feeds follow-ups)."""
    if proposal.status in TERMINAL_STATUSES:
        return
    now = datetime.now(tz=UTC)
    if proposal.first_viewed_at is None:
        proposal.first_viewed_at = now
    proposal.view_count += 1
    if proposal.status == "sent":
        proposal.status = "viewed"


def is_expired(proposal: Proposal) -> bool:
    if proposal.expires_at is None:
        return False
    return datetime.now(tz=UTC) > proposal.expires_at


def sign_proposal(
    db: Session,
    proposal: Proposal,
    *,
    signer_name: str,
    signer_email: str | None,
    ip: str | None,
    user_agent: str | None,
) -> Signature:
    if proposal.status == "signed":
        raise ConflictError("This proposal is already signed.")
    if proposal.status in {"declined", "expired"}:
        raise ConflictError("This proposal can no longer be signed.")
    if not proposal.content_hash:
        raise ConflictError("This proposal is not ready to sign.")
    if is_expired(proposal):
        proposal.status = "expired"
        raise ConflictError("This proposal has expired.")

    signed_at = datetime.now(tz=UTC)
    sig_hash = signature_hash(proposal.content_hash, signer_name, signed_at.isoformat())
    signature = Signature(
        company_id=proposal.company_id,
        proposal_id=proposal.id,
        signer_name=signer_name,
        signer_email=signer_email,
        ip=ip,
        user_agent=user_agent,
        signed_at=signed_at,
        signature_hash=sig_hash,
    )
    db.add(signature)
    proposal.status = "signed"

    # A signed proposal locks its estimate version (§0.1.3).
    estimate = db.get(Estimate, proposal.estimate_id)
    if estimate is not None and estimate.status == "approved":
        estimate.status = "approved"  # already terminal for editing; no-op marker

    audit.record(
        db,
        company_id=proposal.company_id,
        actor_id=None,
        entity="proposal",
        entity_id=proposal.id,
        action="signed",
        after={"signer": signer_name, "signature_hash": sig_hash},
    )
    return signature


def decline_proposal(db: Session, proposal: Proposal, reason: str | None) -> None:
    if proposal.status in {"signed", "declined", "expired"}:
        raise ConflictError("This proposal can no longer be declined.")
    proposal.status = "declined"
    proposal.declined_at = datetime.now(tz=UTC)
    proposal.decline_reason = reason
    audit.record(
        db,
        company_id=proposal.company_id,
        actor_id=None,
        entity="proposal",
        entity_id=proposal.id,
        action="declined",
        after={"reason": reason},
    )


def get_owned_proposal(
    db: Session, company_id: uuid.UUID, proposal_id: uuid.UUID
) -> Proposal:
    proposal = db.get(Proposal, proposal_id)
    if proposal is None or proposal.company_id != company_id:
        raise NotFoundError("Proposal not found.")
    return proposal


def get_by_token(db: Session, token: str) -> Proposal:
    proposal = db.scalar(select(Proposal).where(Proposal.public_token == token))
    if proposal is None:
        raise NotFoundError("Proposal not found.")
    return proposal
