"""Proposal render model — the single frozen representation a proposal is
built from, shared by the hosted web page and the PDF worker.

At send time the document is computed once, hashed, and stored on the
proposal (`snapshot` + `content_hash`). Sent documents are immutable
(§0.1.3): the hosted page and PDF both render this exact object, and the
signature binds to its `content_hash`.

`content_hash = sha256(canonical_json(document))` where canonical JSON has
sorted keys and no volatile fields (no timestamps, no view counts).
"""

import hashlib
import json
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from fieldquote.domain.models import Client, Company, Estimate, Proposal

TERMS_VERSION = "v1-2026-07"

PLATFORM_DISCLAIMER = (
    "This proposal is an estimate prepared and approved by {company}, a licensed "
    "contractor, using FieldQuote software. Final pricing may vary based on site "
    "conditions discovered during work; changes will be documented in a written "
    "change order. Allowance items are budgetary placeholders. FieldQuote provides "
    "drafting software only and is not a party to this agreement."
)

ESIGN_CONSENT = (
    "By typing my name and checking this box, I agree that this constitutes my "
    "electronic signature on this proposal, with the same force as a handwritten "
    "signature, and I consent to do business electronically with {company}."
)

CENT = Decimal("0.01")


def _money(value: Decimal) -> str:
    return str(value.quantize(CENT, rounding=ROUND_HALF_UP))


class DocCompany(BaseModel):
    model_config = ConfigDict(frozen=True)
    name: str
    logo_url: str | None = None
    license_number: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None


class DocClient(BaseModel):
    model_config = ConfigDict(frozen=True)
    name: str | None = None
    email: str | None = None
    address: str | None = None


class DocLine(BaseModel):
    model_config = ConfigDict(frozen=True)
    description: str
    qty: str
    unit: str | None
    line_type: str
    confidence: str
    total: str
    note: str | None = None
    tier: Literal["good", "better", "best"] | None = None
    tier_label: str | None = None
    selected: bool = True


class DocOptionGroup(BaseModel):
    model_config = ConfigDict(frozen=True)
    base_description: str
    tiers: tuple[DocLine, ...]


class ProposalDocument(BaseModel):
    """The complete, frozen proposal. Serialized deterministically for hashing."""

    model_config = ConfigDict(frozen=True)

    company: DocCompany
    client: DocClient
    title: str
    cover_photo_url: str | None
    intro_message: str
    scope_prose: str
    lines: tuple[DocLine, ...]
    option_groups: tuple[DocOptionGroup, ...]
    inclusions: tuple[str, ...]
    exclusions: tuple[str, ...]
    subtotal: str
    tax: str
    total: str
    deposit_label: str
    deposit_amount: str
    validity_days: int
    company_terms: str
    platform_disclaimer: str
    esign_consent: str
    terms_version: str

    def canonical_json(self) -> str:
        return json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":"))

    def content_hash(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


def _tier_of(line_type: str) -> Literal["good", "better", "best"] | None:
    if line_type == "option_good":
        return "good"
    if line_type == "option_better":
        return "better"
    if line_type == "option_best":
        return "best"
    return None


def _deposit(config: dict[str, Any], total: Decimal) -> tuple[str, Decimal]:
    deposit = config.get("deposit", {})
    kind = deposit.get("kind", "percent")
    value = Decimal(str(deposit.get("value", "25")))
    if kind == "flat":
        amount = min(value, total)
        return f"Deposit: ${_money(amount)}", amount
    amount = (total * value / 100).quantize(CENT, rounding=ROUND_HALF_UP)
    amount = min(amount, total)
    return f"Deposit ({value}%)", amount


def build_document(
    proposal: Proposal,
    estimate: Estimate,
    company: Company,
    client: Client | None,
) -> ProposalDocument:
    config = proposal.config or {}
    totals = estimate.totals or {}
    total = Decimal(str(totals.get("total", "0")))

    lines: list[DocLine] = []
    option_map: dict[str, list[DocLine]] = {}
    for line in sorted(estimate.lines, key=lambda entry: entry.position):
        line_totals = line.totals or {}
        doc_line = DocLine(
            description=line.description,
            qty=str(line.qty),
            unit=line.unit,
            line_type=line.line_type,
            confidence=line.confidence,
            total=_money(Decimal(str(line_totals.get("total", "0")))),
            note=line.editable_note,
            tier=_tier_of(line.line_type),
            selected=bool(line_totals.get("included", True)),
        )
        if line.line_type.startswith("option_"):
            base = line.description.split(" — ")[0]
            option_map.setdefault(base, []).append(doc_line)
        else:
            lines.append(doc_line)

    tier_order = {"good": 0, "better": 1, "best": 2}
    option_groups = tuple(
        DocOptionGroup(
            base_description=base,
            tiers=tuple(sorted(group, key=lambda entry: tier_order.get(entry.tier or "", 9))),
        )
        for base, group in option_map.items()
    )

    deposit_label, deposit_amount = _deposit(config, total)
    company_name = company.name or "the contractor"
    return ProposalDocument(
        company=DocCompany(
            name=company_name,
            logo_url=company.logo_url,
            license_number=company.license_number,
            phone=company.phone,
            email=company.email,
            address=company.address,
        ),
        client=DocClient(
            name=client.name if client else None,
            email=client.email if client else None,
            address=client.address if client else None,
        ),
        title=str(config.get("title") or "Project proposal"),
        cover_photo_url=config.get("cover_photo_url"),
        intro_message=str(config.get("intro_message", "")),
        scope_prose=estimate.scope_prose or "",
        lines=tuple(lines),
        option_groups=option_groups,
        inclusions=tuple(config.get("inclusions", [])),
        exclusions=tuple(config.get("exclusions", [])),
        subtotal=_money(Decimal(str(totals.get("subtotal", "0")))),
        tax=_money(Decimal(str(totals.get("tax", "0")))),
        total=_money(total),
        deposit_label=deposit_label,
        deposit_amount=_money(deposit_amount),
        validity_days=int(config.get("validity_days", 30)),
        company_terms=str(config.get("company_terms", "")),
        platform_disclaimer=PLATFORM_DISCLAIMER.format(company=company_name),
        esign_consent=ESIGN_CONSENT.format(company=company_name),
        terms_version=TERMS_VERSION,
    )


def signature_hash(content_hash: str, signer_name: str, signed_at_iso: str) -> str:
    return hashlib.sha256(
        f"{content_hash}{signer_name}{signed_at_iso}".encode()
    ).hexdigest()
