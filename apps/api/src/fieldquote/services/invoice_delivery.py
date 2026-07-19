"""Deliver invoices and payment receipts: render the invoice HTML/PDF and
notify the client by email (and SMS when enabled). Runs in workers; all side
effects are injected so it's testable with fakes.

The invoice document renders from the stored invoice rows only — totals are
never recomputed here (sent invoices are immutable)."""

import html as html_mod
import logging
from decimal import Decimal

from sqlalchemy.orm import Session

from fieldquote.core.config import get_settings
from fieldquote.domain.models import Client, Company, Invoice, Job, Payment
from fieldquote.integrations.messaging import EmailSender, SmsSender, sms_enabled
from fieldquote.integrations.pdf import PdfError, PdfRenderer
from fieldquote.integrations.storage import StorageService
from fieldquote.services import invoicing
from fieldquote.services.proposals import DOCUMENTS_BUCKET

logger = logging.getLogger(__name__)


def _pay_url(token: str | None) -> str | None:
    if not token:
        return None
    return f"{get_settings().public_web_url.rstrip('/')}/i/{token}"


def _usd(value: Decimal | str) -> str:
    return f"${Decimal(str(value)):,.2f}"


def _esc(value: str | None) -> str:
    return html_mod.escape(value or "")


KIND_LABELS = {"deposit": "Deposit", "progress": "Progress payment", "final": "Final balance"}


def invoice_html(db: Session, invoice: Invoice) -> str:
    """Self-contained printable invoice — shared look with the hosted pay page
    (light, trustworthy, safety-orange accent)."""
    company = db.get(Company, invoice.company_id)
    job = db.get(Job, invoice.job_id)
    client = db.get(Client, job.client_id) if job and job.client_id else None
    balance = invoicing.invoice_balance(db, invoice)
    paid = invoicing.refundable_amount(db, invoice)
    rows = "".join(
        f"<tr><td>{_esc(str(item.get('description', '')))}</td>"
        f"<td class='num'>{_usd(str(item.get('amount', '0')))}</td></tr>"
        for item in invoice.line_items or []
    )
    paid_row = (
        f"<tr><td>Paid to date</td><td class='num'>-{_usd(paid)}</td></tr>" if paid > 0 else ""
    )
    due = (
        f"{invoice.due_at.strftime('%B')} {invoice.due_at.day}, {invoice.due_at.year}"
        if invoice.due_at
        else None
    )
    company_name = _esc(company.name if company else "Your contractor")
    license_line = (
        f"<div class='muted'>License {_esc(company.license_number)}</div>"
        if company and company.license_number
        else ""
    )
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Invoice {_esc(invoice.number)}</title>
<style>
  body {{ font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #0F172A;
         margin: 0; padding: 40px; background: #fff; }}
  .head {{ display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 3px solid #0F172A; padding-bottom: 16px; }}
  h1 {{ font-size: 20px; margin: 0; }}
  .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  .muted {{ color: #64748B; font-size: 12px; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 24px; }}
  td, th {{ padding: 10px 4px; border-bottom: 1px solid #E2E8F0; font-size: 14px;
            text-align: left; }}
  .total-row td {{ font-weight: 700; border-top: 2px solid #0F172A; border-bottom: none; }}
  .balance {{ margin-top: 20px; background: #FFF7ED; border: 1px solid #FDBA74;
              border-radius: 8px; padding: 14px 16px; font-size: 15px; }}
  .balance b {{ color: #EA580C; }}
</style></head><body>
<div class="head">
  <div><h1>{company_name}</h1>{license_line}
    <div class="muted">{_esc(company.phone if company else None)}
      {_esc(company.email if company else None)}</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:18px;font-weight:700">Invoice {_esc(invoice.number)}</div>
    <div class="muted">{_esc(KIND_LABELS.get(invoice.kind, invoice.kind))}</div>
    {f'<div class="muted">Due {due}</div>' if due else ''}
  </div>
</div>
<div style="margin-top:16px" class="muted">
  {_esc(client.name if client else None)} — {_esc(job.title if job else None)}
</div>
<table>
  <tr><th>Description</th><th class="num">Amount</th></tr>
  {rows}
  <tr><td>Subtotal</td><td class="num">{_usd(invoice.subtotal)}</td></tr>
  <tr><td>Tax</td><td class="num">{_usd(invoice.tax)}</td></tr>
  {paid_row}
  <tr class="total-row"><td>Balance due</td><td class="num">{_usd(balance)}</td></tr>
</table>
<div class="balance">Balance due: <b>{_usd(balance)}</b></div>
<div class="muted" style="margin-top:32px">Prepared with FieldQuote.
FieldQuote provides drafting software only and is not a party to this agreement.</div>
</body></html>"""


def render_invoice_pdf(
    db: Session, invoice: Invoice, storage: StorageService, pdf: PdfRenderer
) -> str | None:
    html = invoice_html(db, invoice)
    try:
        data = pdf.render(html)
    except PdfError:
        logger.warning("pdf_render_unavailable", extra={"invoice_id": str(invoice.id)})
        return None
    path = f"{invoice.company_id}/invoices/{invoice.id}/{invoice.number}.pdf"
    storage.upload(DOCUMENTS_BUCKET, path, data, "application/pdf")
    invoice.pdf_path = path
    return path


def _client_for(db: Session, invoice: Invoice) -> tuple[Client | None, Company | None, Job | None]:
    job = db.get(Job, invoice.job_id)
    client = db.get(Client, job.client_id) if job and job.client_id else None
    company = db.get(Company, invoice.company_id)
    return client, company, job


def notify_client(db: Session, invoice: Invoice, email: EmailSender, sms: SmsSender) -> None:
    client, company, _job = _client_for(db, invoice)
    company_name = company.name if company else "your contractor"
    url = _pay_url(invoice.public_token)
    balance = invoicing.invoice_balance(db, invoice)
    if client and client.email and url:
        email.send(
            to=client.email,
            subject=f"Invoice {invoice.number} from {company_name}",
            html=(
                f"<p>Hi {client.name or 'there'},</p>"
                f"<p>{company_name} has sent you an invoice for {_usd(balance)}. "
                f"You can review and pay online — card or bank transfer (lower fees):</p>"
                f'<p><a href="{url}">View and pay invoice {invoice.number}</a></p>'
            ),
        )
        logger.info("invoice_emailed", extra={"invoice_id": str(invoice.id)})
    if sms_enabled() and client and client.phone and url:
        sms.send(
            to=client.phone,
            body=f"Invoice {invoice.number} from {company_name} — {_usd(balance)} due: {url}",
        )
        logger.info("invoice_smsed", extra={"invoice_id": str(invoice.id)})


def deliver_invoice(
    db: Session,
    invoice: Invoice,
    storage: StorageService,
    pdf: PdfRenderer,
    email: EmailSender,
    sms: SmsSender,
) -> None:
    render_invoice_pdf(db, invoice, storage, pdf)
    notify_client(db, invoice, email, sms)
    db.commit()


def remind_client(db: Session, invoice: Invoice, email: EmailSender, sms: SmsSender) -> None:
    """A polite nudge — friendly-professional, never a dunning letter."""
    if invoice.status not in invoicing.PAYABLE_STATUSES:
        logger.info("reminder_skipped_not_payable", extra={"invoice_id": str(invoice.id)})
        return
    client, company, _job = _client_for(db, invoice)
    company_name = company.name if company else "your contractor"
    url = _pay_url(invoice.public_token)
    balance = invoicing.invoice_balance(db, invoice)
    if client and client.email and url:
        email.send(
            to=client.email,
            subject=f"Friendly reminder — invoice {invoice.number} from {company_name}",
            html=(
                f"<p>Hi {client.name or 'there'},</p>"
                f"<p>Just a friendly reminder that invoice {invoice.number} for "
                f"{_usd(balance)} is still open. You can pay online in a minute:</p>"
                f'<p><a href="{url}">Pay invoice {invoice.number}</a></p>'
                f"<p>Already taken care of? Please disregard this note.</p>"
            ),
        )
        logger.info("invoice_reminder_emailed", extra={"invoice_id": str(invoice.id)})
    if sms_enabled() and client and client.phone and url:
        sms.send(
            to=client.phone,
            body=(
                f"Friendly reminder from {company_name}: invoice {invoice.number} "
                f"({_usd(balance)}) is still open. Pay here: {url}"
            ),
        )


def send_receipt(db: Session, payment: Payment, email: EmailSender) -> None:
    invoice = db.get(Invoice, payment.invoice_id)
    if invoice is None or payment.status != "succeeded":
        return
    client, company, _job = _client_for(db, invoice)
    company_name = company.name if company else "your contractor"
    balance = invoicing.invoice_balance(db, invoice)
    closing = (
        "<p>This invoice is now paid in full. Thank you!</p>"
        if balance <= 0
        else f"<p>Remaining balance: {_usd(balance)}.</p>"
    )
    if client and client.email:
        email.send(
            to=client.email,
            subject=f"Receipt — {_usd(payment.amount)} to {company_name}",
            html=(
                f"<p>Hi {client.name or 'there'},</p>"
                f"<p>We received your payment of <b>{_usd(payment.amount)}</b> "
                f"toward invoice {invoice.number} from {company_name}.</p>"
                + closing
            ),
        )
        logger.info("receipt_emailed", extra={"payment_id": str(payment.id)})
