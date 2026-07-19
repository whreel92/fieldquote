"""Estimate read endpoints + generation trigger.

Phase 3 scope: list/detail + queue a generation. Editing and the approval
flow are Phase 5 — note there is deliberately NO send/approve endpoint here,
and estimates are only ever created as drafts (§0.1.2)."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from fieldquote.ai.scoping.checklist import ChecklistError, ChecklistModel, ClaudeChecklist
from fieldquote.ai.types import CaptureInput, CatalogSummaryEntry, ScopingContext
from fieldquote.core.config import get_settings
from fieldquote.core.db import get_db
from fieldquote.core.errors import AppError, ConflictError, NotFoundError
from fieldquote.core.tenancy import TenantContext, get_current_context, require_role
from fieldquote.domain.models import Capture, Estimate, EstimateLine, Job
from fieldquote.pricing import PricingError
from fieldquote.services import audit
from fieldquote.services import estimate_editing as editing
from fieldquote.services.catalog import load_catalog
from fieldquote.services.generation import JOB_TYPE_CODES
from fieldquote.services.queue import Queue, get_queue

router = APIRouter(tags=["estimates"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]
Q = Annotated[Queue, Depends(get_queue)]


def get_checklist_model() -> ChecklistModel:
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise AppError("Suggestions are unavailable right now.", details={"code": "no_provider"})
    return ClaudeChecklist(settings.anthropic_api_key)


Checklist = Annotated[ChecklistModel, Depends(get_checklist_model)]


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


# ── Phase 5: editing, approval, versioning ───────────────────────────────────


class ManualEstimateIn(BaseModel):
    scope_prose: str = ""


class EstimatePatch(BaseModel):
    margin_override_pct: Decimal | None = Field(default=None, ge=0, lt=100)
    scope_prose: str | None = None


class LineAdd(BaseModel):
    assembly_code: str | None = None
    qty: Decimal = Field(default=Decimal(1), gt=0)
    modifiers: list[str] = Field(default_factory=list)
    selected_tier: Literal["good", "better", "best"] | None = None
    # manual line fields (used when assembly_code is null)
    description: str | None = None
    unit: str = "ea"
    unit_price: Decimal | None = Field(default=None, ge=0)
    line_type: Literal["standard", "allowance", "verify"] = "standard"
    editable_note: str | None = None


class LinePatch(BaseModel):
    qty: Decimal | None = Field(default=None, gt=0)
    modifiers: list[str] | None = None
    description: str | None = None
    unit_price: Decimal | None = Field(default=None, ge=0)
    labor_hours: Decimal | None = Field(default=None, ge=0)
    material_cost: Decimal | None = Field(default=None, ge=0)
    editable_note: str | None = None


class ConvertAllowanceIn(BaseModel):
    amount: Decimal = Field(ge=0)


class OptionTierIn(BaseModel):
    tier: Literal["good", "better", "best"]
    label: str
    total: Decimal = Field(ge=0)


class OptionsIn(BaseModel):
    tiers: list[OptionTierIn] = Field(min_length=2, max_length=3)
    selected: Literal["good", "better", "best"] = "good"


class ApproveIn(BaseModel):
    confirmations: dict[str, bool]


class SuggestionOut(BaseModel):
    assembly_code: str | None
    description: str
    reason: str


class SuggestionsOut(BaseModel):
    suggestions: list[SuggestionOut]


def _lines(db: Session, estimate: Estimate) -> list[EstimateLine]:
    return list(
        db.scalars(
            select(EstimateLine)
            .where(EstimateLine.estimate_id == estimate.id)
            .order_by(EstimateLine.position)
        )
    )


def _finalize(
    db: Session,
    ctx: TenantContext,
    estimate: Estimate,
    action: str,
    after: dict[str, Any] | None = None,
) -> EstimateDetail:
    editing.recompute_estimate_totals(estimate, _lines(db, estimate))
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="estimate",
        entity_id=estimate.id,
        action=action,
        after=after,
    )
    db.commit()
    return get_estimate(estimate.id, ctx, db)


@router.post("/jobs/{job_id}/estimates", status_code=201)
def create_manual_estimate(
    job_id: uuid.UUID, body: ManualEstimateIn, ctx: Ctx, db: Db
) -> EstimateDetail:
    job = _get_job(db, ctx, job_id)
    from fieldquote.services.catalog import company_region, load_company_rates

    rates = load_company_rates(db, ctx.company)
    estimate = Estimate(
        company_id=ctx.company.id,
        job_id=job.id,
        version=(
            db.scalar(
                select(Estimate.version)
                .where(Estimate.job_id == job.id)
                .order_by(Estimate.version.desc())
                .limit(1)
            )
            or 0
        )
        + 1,
        status="draft",
        source="manual",
        scope_prose=body.scope_prose,
        totals={
            "subtotal": "0",
            "tax": "0",
            "total": "0",
            "pricing_context": {
                "pct": str(rates.target_margin_pct),
                "tax_rate_pct": str(rates.tax_rate_pct),
                "markup_model": rates.markup_model,
                "labor_rate": str(rates.labor_rate),
                "margin_floor_pct": str(rates.margin_floor_pct),
                "region": company_region(ctx.company),
            },
        },
    )
    db.add(estimate)
    db.flush()
    return _finalize(db, ctx, estimate, "create_manual")


@router.patch("/estimates/{estimate_id}")
def patch_estimate(
    estimate_id: uuid.UUID, body: EstimatePatch, ctx: Ctx, db: Db
) -> EstimateDetail:
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    editing.ensure_editable(estimate)
    changes: dict[str, Any] = {}
    if body.scope_prose is not None:
        estimate.scope_prose = body.scope_prose
        changes["scope_prose"] = "edited"
    if body.margin_override_pct is not None:
        pct = body.margin_override_pct
        totals = dict(estimate.totals or {})
        context = dict(totals.get("pricing_context", {}))
        context["pct"] = str(pct)
        totals["pricing_context"] = context
        estimate.totals = totals
        catalog = load_catalog(db, ctx.company)
        for line in _lines(db, estimate):
            if (
                line.assembly_code
                and line.price_source == "engine"
                and line.line_type not in ("allowance", "verify")
            ):
                try:
                    editing.engine_reprice_line(
                        db, ctx.company, estimate, line, pct_override=pct, catalog=catalog
                    )
                except PricingError:
                    continue  # catalog drift — leave the line as-is
        changes["margin_override_pct"] = str(pct)
    return _finalize(db, ctx, estimate, "estimate_update", after=changes)


@router.post("/estimates/{estimate_id}/lines", status_code=201)
def add_line(estimate_id: uuid.UUID, body: LineAdd, ctx: Ctx, db: Db) -> EstimateDetail:
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    editing.ensure_editable(estimate)
    lines = _lines(db, estimate)
    line = EstimateLine(
        company_id=ctx.company.id,
        estimate_id=estimate.id,
        position=editing.next_position(lines),
        qty=body.qty,
        unit=body.unit,
        line_type=body.line_type,
        editable_note=body.editable_note,
        description=body.description or "",
        totals={"unit_price": "0", "total": "0", "included": True, "overrides": {}},
    )
    if body.assembly_code:
        catalog = load_catalog(db, ctx.company)
        line.assembly_code = body.assembly_code
        line.description = body.description or ""
        db.add(line)
        db.flush()
        try:
            editing.engine_reprice_line(
                db,
                ctx.company,
                estimate,
                line,
                qty=body.qty,
                modifiers=body.modifiers,
                catalog=catalog,
            )
        except PricingError as exc:
            raise ConflictError(exc.message, details={"code": exc.code}) from exc
        if not line.description:
            assembly = catalog.assemblies.get(body.assembly_code)
            line.description = assembly.name if assembly else body.assembly_code
            line.unit = assembly.unit if assembly else line.unit
    else:
        if not body.description:
            raise ConflictError("Manual lines need a description.")
        line.price_source = "manual"
        line.confidence = "allowance" if body.line_type == "allowance" else (
            "verify" if body.line_type == "verify" else "known"
        )
        unit_price = body.unit_price or Decimal(0)
        line.totals = {
            "unit_price": str(editing.money(unit_price)),
            "total": str(editing.money(unit_price * body.qty)),
            "included": True,
            "overrides": {"unit_price": True} if body.unit_price is not None else {},
        }
        db.add(line)
        db.flush()
    return _finalize(
        db, ctx, estimate, "line_add", after={"description": line.description}
    )


@router.patch("/estimates/{estimate_id}/lines/{line_id}")
def patch_line(
    estimate_id: uuid.UUID, line_id: uuid.UUID, body: LinePatch, ctx: Ctx, db: Db
) -> EstimateDetail:
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    editing.ensure_editable(estimate)
    line = editing.get_owned_line(db, estimate, line_id)
    before = {"qty": str(line.qty), "total": str((line.totals or {}).get("total"))}
    if body.description is not None:
        line.description = body.description
    if body.editable_note is not None:
        line.editable_note = body.editable_note

    manual_touch = (
        body.unit_price is not None
        or body.labor_hours is not None
        or body.material_cost is not None
    )
    engine_line = (
        line.assembly_code is not None
        and line.price_source == "engine"
        and line.line_type not in ("allowance", "verify")
    )
    if manual_touch:
        editing.manual_override_line(
            estimate,
            line,
            unit_price=body.unit_price,
            labor_hours=body.labor_hours,
            material_cost=body.material_cost,
            qty=body.qty,
        )
    elif (body.qty is not None or body.modifiers is not None) and engine_line:
        try:
            editing.engine_reprice_line(
                db, ctx.company, estimate, line, qty=body.qty, modifiers=body.modifiers
            )
        except PricingError as exc:
            raise ConflictError(exc.message, details={"code": exc.code}) from exc
    elif body.qty is not None:
        editing.manual_override_line(estimate, line, qty=body.qty)
    after = {"qty": str(line.qty), "total": str((line.totals or {}).get("total"))}
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="estimate_line",
        entity_id=line.id,
        action="line_update",
        before=before,
        after=after,
    )
    return _finalize(db, ctx, estimate, "line_update", after=after)


@router.delete("/estimates/{estimate_id}/lines/{line_id}")
def delete_line(
    estimate_id: uuid.UUID, line_id: uuid.UUID, ctx: Ctx, db: Db
) -> EstimateDetail:
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    editing.ensure_editable(estimate)
    line = editing.get_owned_line(db, estimate, line_id)
    description = line.description
    db.delete(line)
    db.flush()
    return _finalize(db, ctx, estimate, "line_delete", after={"description": description})


@router.post("/estimates/{estimate_id}/lines/{line_id}/convert")
def convert_allowance(
    estimate_id: uuid.UUID, line_id: uuid.UUID, body: ConvertAllowanceIn, ctx: Ctx, db: Db
) -> EstimateDetail:
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    editing.ensure_editable(estimate)
    line = editing.get_owned_line(db, estimate, line_id)
    if line.line_type != "allowance":
        raise ConflictError("Only allowance lines can be converted.")
    line.line_type = "standard"
    line.confidence = "known"
    line.price_source = "manual"
    amount = editing.money(body.amount)
    line.totals = {
        **(line.totals or {}),
        "unit_price": str(amount),
        "total": str(editing.money(amount * line.qty)),
        "overrides": {**editing.line_overrides(line), "unit_price": True},
    }
    return _finalize(
        db, ctx, estimate, "allowance_convert", after={"amount": str(amount)}
    )


@router.post("/estimates/{estimate_id}/lines/{line_id}/options")
def build_options(
    estimate_id: uuid.UUID, line_id: uuid.UUID, body: OptionsIn, ctx: Ctx, db: Db
) -> EstimateDetail:
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    editing.ensure_editable(estimate)
    line = editing.get_owned_line(db, estimate, line_id)
    tiers = {tier.tier for tier in body.tiers}
    if body.selected not in tiers:
        raise ConflictError("Selected tier must be one of the provided tiers.")
    if "good" not in tiers:
        raise ConflictError("Options must include a 'good' tier.")
    base_position = line.position
    tier_order = ["good", "better", "best"]
    ordered = sorted(body.tiers, key=lambda t: tier_order.index(t.tier))
    for index, tier in enumerate(ordered):
        position = (
            base_position if index == 0 else editing.next_position(_lines(db, estimate))
        )
        db.add(
            EstimateLine(
                company_id=ctx.company.id,
                estimate_id=estimate.id,
                position=position,
                assembly_code=line.assembly_code,
                description=f"{line.description} — {tier.label}",
                qty=line.qty,
                unit=line.unit,
                line_type=f"option_{tier.tier}",
                price_source="manual",
                confidence=line.confidence,
                totals={
                    "unit_price": str(editing.money(tier.total / line.qty)),
                    "total": str(editing.money(tier.total)),
                    "included": tier.tier == body.selected,
                    "overrides": {"unit_price": True},
                },
            )
        )
        db.flush()
    db.delete(line)
    db.flush()
    return _finalize(db, ctx, estimate, "options_built", after={"tiers": sorted(tiers)})


@router.post("/estimates/{estimate_id}/approve")
def approve(estimate_id: uuid.UUID, body: ApproveIn, ctx: Ctx, db: Db) -> EstimateDetail:
    require_role(ctx, "owner", "admin", "office")
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    editing.approve_estimate(estimate, ctx.user, body.confirmations)
    # A newly approved version supersedes any previously approved one (§0.1.3).
    for other in db.scalars(
        select(Estimate).where(
            Estimate.job_id == estimate.job_id,
            Estimate.id != estimate.id,
            Estimate.status == "approved",
        )
    ):
        other.status = "superseded"
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="estimate",
        entity_id=estimate.id,
        action="approve",
        after={"version": estimate.version, "total": (estimate.totals or {}).get("total")},
    )
    db.commit()
    return get_estimate(estimate.id, ctx, db)


@router.post("/estimates/{estimate_id}/fork", status_code=201)
def fork(estimate_id: uuid.UUID, ctx: Ctx, db: Db) -> EstimateDetail:
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    new_estimate = editing.fork_estimate(db, estimate, ctx.user)
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="estimate",
        entity_id=new_estimate.id,
        action="fork",
        after={"from_version": estimate.version, "to_version": new_estimate.version},
    )
    db.commit()
    return get_estimate(new_estimate.id, ctx, db)


@router.get("/estimates/{estimate_id}/diff/{other_id}")
def diff(
    estimate_id: uuid.UUID, other_id: uuid.UUID, ctx: Ctx, db: Db
) -> dict[str, Any]:
    a = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    b = editing.get_owned_estimate(db, ctx.company.id, other_id)
    return editing.diff_estimates(a, b)


@router.post("/estimates/{estimate_id}/suggestions")
def suggestions(
    estimate_id: uuid.UUID, ctx: Ctx, db: Db, checklist: Checklist
) -> SuggestionsOut:
    estimate = editing.get_owned_estimate(db, ctx.company.id, estimate_id)
    job = db.get(Job, estimate.job_id)
    if job is None:
        raise NotFoundError("Job not found.")
    catalog = load_catalog(db, ctx.company)
    captures = list(
        db.scalars(
            select(Capture).where(
                Capture.job_id == job.id, Capture.upload_state == "uploaded"
            )
        )
    )
    context = ScopingContext(
        job_title=job.title,
        job_type_code=job.job_type_code,
        job_address=job.address,
        captures=[
            CaptureInput(
                capture_id=str(capture.id),
                kind="photo" if capture.kind == "photo" else "audio",
                transcript=capture.transcript if capture.kind == "audio" else None,
                vision_findings=None,
            )
            for capture in captures
        ],
        catalog=[
            CatalogSummaryEntry(
                code=assembly.code,
                name=assembly.name,
                unit=assembly.unit,
                job_type_codes=list(assembly.job_type_codes),
                modifiers_allowed=list(assembly.modifiers_allowed),
                has_option_tiers=bool(assembly.option_tiers),
            )
            for assembly in sorted(catalog.assemblies.values(), key=lambda a: a.code)
        ],
        modifier_codes=sorted(catalog.modifiers),
        job_type_codes=JOB_TYPE_CODES,
    )
    current_lines = [
        f"{line.description} (qty {line.qty}, {line.line_type})"
        for line in _lines(db, estimate)
    ]
    try:
        output = checklist.review(context, current_lines)
    except ChecklistError as exc:
        raise AppError(
            "Suggestions are unavailable right now.", details={"code": "checklist_failed"}
        ) from exc
    valid = [
        suggestion
        for suggestion in output.suggestions
        if suggestion.assembly_code is None or suggestion.assembly_code in catalog.assemblies
    ][:5]
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="estimate",
        entity_id=estimate.id,
        action="suggestions_requested",
        after={"count": len(valid)},
    )
    db.commit()
    return SuggestionsOut(
        suggestions=[
            SuggestionOut(
                assembly_code=suggestion.assembly_code,
                description=suggestion.description,
                reason=suggestion.reason,
            )
            for suggestion in valid
        ]
    )


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
