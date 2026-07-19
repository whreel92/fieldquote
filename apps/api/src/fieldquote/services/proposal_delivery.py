"""Deliver a sent proposal: render the PDF snapshot and notify the client by
email (and SMS when enabled). Runs in a worker after send freezes the
snapshot. All side effects are injected so it's testable with fakes.

Delivery never mutates the frozen document — it only renders/sends it. A
delivery failure is logged and surfaced (dead-lettered by the worker), never
silently swallowed."""

import logging

from sqlalchemy.orm import Session

from fieldquote.core.config import get_settings
from fieldquote.domain.models import Client, Estimate, Job, Proposal
from fieldquote.integrations.messaging import EmailSender, SmsSender, sms_enabled
from fieldquote.integrations.pdf import PdfError, PdfRenderer
from fieldquote.integrations.storage import StorageService
from fieldquote.services.proposals import DOCUMENTS_BUCKET

logger = logging.getLogger(__name__)


def _proposal_url(token: str) -> str:
    return f"{get_settings().public_web_url.rstrip('/')}/p/{token}"


def render_pdf(
    db: Session, proposal: Proposal, storage: StorageService, pdf: PdfRenderer
) -> str | None:
    if proposal.html_snapshot_path is None:
        return None
    html = storage.download(DOCUMENTS_BUCKET, proposal.html_snapshot_path).decode("utf-8")
    try:
        data = pdf.render(html)
    except PdfError:
        # Playwright/browser unavailable — keep the HTML snapshot, skip the PDF.
        logger.warning("pdf_render_unavailable", extra={"proposal_id": str(proposal.id)})
        return None
    path = f"{proposal.company_id}/{proposal.id}/proposal-{proposal.version}.pdf"
    storage.upload(DOCUMENTS_BUCKET, path, data, "application/pdf")
    proposal.pdf_path = path
    return path


def notify_client(
    db: Session,
    proposal: Proposal,
    email: EmailSender,
    sms: SmsSender,
) -> None:
    estimate = db.get(Estimate, proposal.estimate_id)
    job = db.get(Job, estimate.job_id) if estimate else None
    client = db.get(Client, job.client_id) if job and job.client_id else None
    company = proposal.company_id
    url = _proposal_url(proposal.public_token)
    snapshot = proposal.snapshot or {}
    company_name = (snapshot.get("company") or {}).get("name", "your contractor")

    if client and client.email:
        email.send(
            to=client.email,
            subject=f"Your proposal from {company_name}",
            html=(
                f"<p>Hi {client.name or 'there'},</p>"
                f"<p>{company_name} has sent you a proposal. "
                f'Review, sign, and pay your deposit here:</p>'
                f'<p><a href="{url}">View your proposal</a></p>'
            ),
        )
        logger.info("proposal_emailed", extra={"proposal_id": str(proposal.id)})

    if sms_enabled() and client and client.phone:
        sms.send(to=client.phone, body=f"Your proposal from {company_name} is ready: {url}")
        logger.info("proposal_smsed", extra={"proposal_id": str(proposal.id)})

    _ = company


def deliver_proposal(
    db: Session,
    proposal: Proposal,
    storage: StorageService,
    pdf: PdfRenderer,
    email: EmailSender,
    sms: SmsSender,
) -> None:
    render_pdf(db, proposal, storage, pdf)
    notify_client(db, proposal, email, sms)
    db.commit()
