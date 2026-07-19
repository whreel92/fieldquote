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


async def deliver_proposal(ctx: dict[str, Any], proposal_id: str) -> str:
    """Render the proposal PDF and notify the client. Retries on transient
    failure; the HTML snapshot already exists so nothing is lost."""
    from fieldquote.domain.models import Proposal
    from fieldquote.integrations.messaging import get_email_sender, get_sms_sender
    from fieldquote.integrations.pdf import get_pdf_renderer
    from fieldquote.services.proposal_delivery import deliver_proposal as run_delivery

    engine = create_engine(get_settings().database_url)
    try:
        with Session(engine) as db:
            proposal = db.get(Proposal, uuid.UUID(proposal_id))
            if proposal is None:
                return "missing"
            run_delivery(
                db,
                proposal,
                get_storage(),
                get_pdf_renderer(),
                get_email_sender(),
                get_sms_sender(),
            )
            return str(proposal.id)
    finally:
        engine.dispose()


async def deliver_invoice(ctx: dict[str, Any], invoice_id: str) -> str:
    """Render the invoice PDF and email/SMS the pay link."""
    from fieldquote.domain.models import Invoice
    from fieldquote.integrations.messaging import get_email_sender, get_sms_sender
    from fieldquote.integrations.pdf import get_pdf_renderer
    from fieldquote.services.invoice_delivery import deliver_invoice as run_delivery

    engine = create_engine(get_settings().database_url)
    try:
        with Session(engine) as db:
            invoice = db.get(Invoice, uuid.UUID(invoice_id))
            if invoice is None:
                return "missing"
            run_delivery(
                db,
                invoice,
                get_storage(),
                get_pdf_renderer(),
                get_email_sender(),
                get_sms_sender(),
            )
            return str(invoice.id)
    finally:
        engine.dispose()


async def remind_invoice(ctx: dict[str, Any], invoice_id: str) -> str:
    """Send a polite payment nudge. Skips invoices that are no longer payable
    (paid/refunded between enqueue and send)."""
    from fieldquote.domain.models import Invoice
    from fieldquote.integrations.messaging import get_email_sender, get_sms_sender
    from fieldquote.services.invoice_delivery import remind_client

    engine = create_engine(get_settings().database_url)
    try:
        with Session(engine) as db:
            invoice = db.get(Invoice, uuid.UUID(invoice_id))
            if invoice is None:
                return "missing"
            remind_client(db, invoice, get_email_sender(), get_sms_sender())
            return str(invoice.id)
    finally:
        engine.dispose()


async def send_receipt(ctx: dict[str, Any], payment_id: str) -> str:
    """Email the payer a receipt for a settled payment."""
    from fieldquote.domain.models import Payment
    from fieldquote.integrations.messaging import get_email_sender
    from fieldquote.services.invoice_delivery import send_receipt as run_receipt

    engine = create_engine(get_settings().database_url)
    try:
        with Session(engine) as db:
            payment = db.get(Payment, uuid.UUID(payment_id))
            if payment is None:
                return "missing"
            run_receipt(db, payment, get_email_sender())
            return str(payment.id)
    finally:
        engine.dispose()


class WorkerSettings:
    functions: ClassVar[list[Any]] = [
        generate_estimate,
        deliver_proposal,
        deliver_invoice,
        remind_invoice,
        send_receipt,
    ]
    max_tries = MAX_TRIES
    retry_delay = 5.0

    @staticmethod
    def redis_settings() -> Any:
        from arq.connections import RedisSettings

        return RedisSettings.from_dsn(get_settings().redis_url)
