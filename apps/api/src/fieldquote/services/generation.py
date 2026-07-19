"""Generation orchestrator: captures → ASR → vision → scoping → PRICING
ENGINE → draft estimate.

Providers are injected (fakes in tests, real in workers). The model never
prices: its validated output is converted to a PricingRequest and every
dollar figure comes from `fieldquote.pricing.price` (§0.1.1). The result is
always a DRAFT (§0.1.2).
"""

import json
import logging
import time
import uuid
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fieldquote.ai.asr.base import ASRError, ASRProvider
from fieldquote.ai.scoping.base import ScopingError, ScopingModel
from fieldquote.ai.types import (
    CaptureInput,
    CatalogSummaryEntry,
    GenerationFailure,
    ScopingContext,
    ScopingOutput,
    VisionFindings,
)
from fieldquote.ai.vision.base import VisionAnalyzer, VisionError
from fieldquote.domain.models import Capture, Company, Estimate, EstimateLine, Job
from fieldquote.integrations.storage import StorageService
from fieldquote.pricing import Catalog, PricedEstimate, PricingRequest, price
from fieldquote.services import instrumentation
from fieldquote.services.catalog import company_region, load_catalog, load_company_rates
from fieldquote.services.events import EventBus, job_channel
from fieldquote.services.scoping_validation import validate_scoping

logger = logging.getLogger(__name__)

JOB_TYPE_CODES = [
    "panel_upgrade", "ev_charger", "service_call", "circuits_outlets",
    "fixtures_fans", "remodel", "generator", "other",
]  # fmt: skip

AUDIO_BUCKET = "job-audio"
PHOTO_BUCKET = "job-photos"

AUDIO_CONTENT_TYPE = "audio/m4a"
PHOTO_CONTENT_TYPE = "image/jpeg"


class Providers:
    """Bundle of injected AI providers."""

    def __init__(
        self,
        asr: ASRProvider,
        asr_fallback: ASRProvider | None,
        vision: VisionAnalyzer,
        scoping: ScopingModel,
    ) -> None:
        self.asr = asr
        self.asr_fallback = asr_fallback
        self.vision = vision
        self.scoping = scoping


def transcribe_capture(
    db: Session, capture: Capture, providers: Providers, storage: StorageService
) -> None:
    """ASR one audio capture (idempotent — skips if transcript exists)."""
    if capture.transcript is not None:
        return
    audio = storage.download(AUDIO_BUCKET, capture.storage_path)
    if not audio:
        capture.transcript = ""
        db.commit()
        return
    started = time.monotonic()
    try:
        result = providers.asr.transcribe(audio, AUDIO_CONTENT_TYPE)
    except ASRError as primary_error:
        if providers.asr_fallback is None:
            raise GenerationFailure(
                "We couldn't process the audio. Check your connection and try again.",
                internal=f"asr failed, no fallback: {primary_error}",
            ) from primary_error
        try:
            result = providers.asr_fallback.transcribe(audio, AUDIO_CONTENT_TYPE)
        except ASRError as fallback_error:
            raise GenerationFailure(
                "We couldn't process the audio. Check your connection and try again.",
                internal=f"asr+fallback failed: {primary_error} / {fallback_error}",
            ) from fallback_error
    capture.transcript = result.text
    if result.duration_s is not None:
        capture.duration_s = Decimal(str(result.duration_s))
    db.commit()
    instrumentation.record_provider_call(
        "asr", result.provider, duration_s=time.monotonic() - started
    )


def analyze_capture(
    db: Session, capture: Capture, providers: Providers, storage: StorageService
) -> None:
    """Vision-analyze one photo capture (idempotent)."""
    if capture.vision_findings is not None:
        return
    image = storage.download(PHOTO_BUCKET, capture.storage_path)
    if not image:
        capture.vision_findings = {}
        db.commit()
        return
    started = time.monotonic()
    try:
        findings = providers.vision.analyze(image, PHOTO_CONTENT_TYPE)
    except VisionError as exc:
        # A photo we can't analyze degrades the input, not the whole run.
        logger.warning("vision_failed", extra={"capture_id": str(capture.id), "error": str(exc)})
        capture.vision_findings = {"error": "analysis_failed"}
        db.commit()
        return
    capture.vision_findings = json.loads(findings.model_dump_json())
    db.commit()
    instrumentation.record_provider_call(
        "vision", findings.provider, duration_s=time.monotonic() - started
    )


def build_context(job: Job, captures: list[Capture], catalog: Catalog) -> ScopingContext:
    inputs: list[CaptureInput] = []
    for capture in captures:
        findings: VisionFindings | None = None
        if capture.kind == "photo" and capture.vision_findings and "error" not in (
            capture.vision_findings or {}
        ):
            findings = VisionFindings.model_validate(capture.vision_findings)
        inputs.append(
            CaptureInput(
                capture_id=str(capture.id),
                kind="photo" if capture.kind == "photo" else "audio",
                transcript=capture.transcript if capture.kind == "audio" else None,
                vision_findings=findings,
            )
        )
    summary = [
        CatalogSummaryEntry(
            code=assembly.code,
            name=assembly.name,
            unit=assembly.unit,
            job_type_codes=list(assembly.job_type_codes),
            modifiers_allowed=list(assembly.modifiers_allowed),
            has_option_tiers=bool(assembly.option_tiers),
        )
        for assembly in sorted(catalog.assemblies.values(), key=lambda a: a.code)
    ]
    return ScopingContext(
        job_title=job.title,
        job_type_code=job.job_type_code,
        job_address=job.address,
        captures=inputs,
        catalog=summary,
        modifier_codes=sorted(catalog.modifiers),
        job_type_codes=JOB_TYPE_CODES,
    )


def _scope_with_repair(
    providers: Providers,
    context: ScopingContext,
    catalog: Catalog,
    event_bus: EventBus,
    channel: str,
) -> ScopingOutput:
    def on_prose(chunk: str) -> None:
        event_bus.publish(channel, "scope.partial", {"text": chunk})

    try:
        output = providers.scoping.scope(context, on_prose=on_prose)
    except ScopingError as exc:
        raise GenerationFailure(
            "Estimate generation hit a snag. Try again in a moment.",
            internal=f"scoping call failed: {exc}",
        ) from exc

    errors = validate_scoping(output, catalog, JOB_TYPE_CODES)
    if not errors:
        return output

    # One repair retry with the exact validation errors (§Phase 3.5).
    try:
        output = providers.scoping.scope(
            context, on_prose=None, repair_hint="\n".join(errors)
        )
    except ScopingError as exc:
        raise GenerationFailure(
            "Estimate generation hit a snag. Try again in a moment.",
            internal=f"scoping repair call failed: {exc}",
        ) from exc
    errors = validate_scoping(output, catalog, JOB_TYPE_CODES)
    if errors:
        raise GenerationFailure(
            "We couldn't turn this capture into a clean estimate. "
            "Try again, or build the estimate manually.",
            internal="scoping invalid after repair: " + "; ".join(errors),
        )
    return output


def _next_version(db: Session, job_id: uuid.UUID) -> int:
    current = db.scalar(select(func.max(Estimate.version)).where(Estimate.job_id == job_id))
    return (current or 0) + 1


def _decimal_str(value: Decimal) -> str:
    return str(value)


def _store_estimate(
    db: Session,
    job: Job,
    output: ScopingOutput,
    priced: PricedEstimate | None,
) -> Estimate:
    rates = load_company_rates(db, db.get(Company, job.company_id) or Company(name=""))
    pricing_context = {
        "pct": _decimal_str(rates.target_margin_pct),
        "tax_rate_pct": _decimal_str(rates.tax_rate_pct),
        "markup_model": rates.markup_model,
        "labor_rate": _decimal_str(rates.labor_rate),
        "margin_floor_pct": _decimal_str(rates.margin_floor_pct),
        "region": company_region(db.get(Company, job.company_id) or Company(name="")),
    }
    estimate = Estimate(
        company_id=job.company_id,
        job_id=job.id,
        version=_next_version(db, job.id),
        status="draft",
        source="ai",
        scope_prose=output.scope_prose,
        ai_output=json.loads(output.model_dump_json()),
        totals=(
            {
                "subtotal_material": _decimal_str(priced.subtotal_material),
                "subtotal_labor": _decimal_str(priced.subtotal_labor),
                "subtotal": _decimal_str(priced.subtotal),
                "tax": _decimal_str(priced.tax),
                "total": _decimal_str(priced.total),
                "margin_check": json.loads(priced.margin_check.model_dump_json()),
                "engine_version": priced.engine_version,
                "pricing_context": pricing_context,
            }
            if priced
            else {"subtotal": "0", "tax": "0", "total": "0", "pricing_context": pricing_context}
        ),
    )
    db.add(estimate)
    db.flush()

    position = 0
    if priced is not None:
        for line in priced.lines:
            db.add(
                EstimateLine(
                    company_id=job.company_id,
                    estimate_id=estimate.id,
                    position=line.position,
                    assembly_code=line.assembly_code,
                    description=line.description,
                    qty=line.qty,
                    unit=line.unit,
                    material_cost=line.material_cost,
                    labor_hours=line.labor_hours,
                    labor_rate=line.labor_rate,
                    line_type=line.line_type,
                    price_source=line.price_source,
                    confidence=line.confidence,
                    editable_note=line.editable_note or None,
                    totals=json.loads(
                        line.model_dump_json(
                            include={"unit_price", "total", "included", "breakdown"}
                        )
                    ),
                )
            )
            position = max(position, line.position + 1)

    for flag in output.verify_flags:
        db.add(
            EstimateLine(
                company_id=job.company_id,
                estimate_id=estimate.id,
                position=position,
                assembly_code=None,
                description=flag.item,
                qty=Decimal(1),
                unit="ea",
                material_cost=Decimal(0),
                labor_hours=Decimal(0),
                labor_rate=Decimal(0),
                line_type="verify",
                price_source="engine",
                confidence="verify",
                editable_note=flag.action,
                totals={"unit_price": "0.00", "total": "0.00", "included": True},
            )
        )
        position += 1

    db.commit()
    db.refresh(estimate)
    return estimate


def run_generation(
    db: Session,
    job_id: uuid.UUID,
    providers: Providers,
    storage: StorageService,
    event_bus: EventBus,
) -> Estimate:
    """The full pipeline for one job. Raises GenerationFailure with a
    user-safe message; the caller records the failed estimate row."""
    started = time.monotonic()
    job = db.get(Job, job_id)
    if job is None:
        raise GenerationFailure("Job not found.", internal=f"job {job_id} missing")
    company = db.get(Company, job.company_id)
    if company is None:
        raise GenerationFailure("Company not found.", internal="company missing")

    channel = job_channel(job.id)
    event_bus.publish(channel, "generation.started", {"job_id": str(job.id)})

    captures = list(
        db.scalars(
            select(Capture)
            .where(Capture.job_id == job.id, Capture.upload_state == "uploaded")
            .order_by(Capture.created_at)
        )
    )
    if not captures:
        raise GenerationFailure(
            "Add at least one photo or voice note before generating an estimate."
        )

    for capture in captures:
        if capture.kind == "audio":
            transcribe_capture(db, capture, providers, storage)
        else:
            analyze_capture(db, capture, providers, storage)

    catalog = load_catalog(db, company)
    if not catalog.assemblies:
        raise GenerationFailure(
            "No priced assemblies are available yet.",
            internal="catalog empty (production guard or unseeded db)",
        )
    context = build_context(job, captures, catalog)
    output = _scope_with_repair(providers, context, catalog, event_bus, channel)

    priced: PricedEstimate | None = None
    if not output.outside_supported_scope and (output.assemblies or output.allowances):
        request = PricingRequest.model_validate(
            {
                "assemblies": [
                    {
                        "code": scoped.code,
                        "qty": scoped.qty,
                        "modifiers": scoped.modifiers,
                        "selected_tier": scoped.selected_tier,
                    }
                    for scoped in output.assemblies
                ],
                # LLM never prices: AI allowances land at $0 for the
                # contractor to fill in during review (Phase 5 convert flow).
                "allowances": [
                    {
                        "description": allowance.description,
                        "amount": "0",
                        "reason": allowance.reason,
                    }
                    for allowance in output.allowances
                ],
                "company_rates": load_company_rates(db, company),
                "region": company_region(company),
            }
        )
        priced = price(request, catalog)

    estimate = _store_estimate(db, job, output, priced)
    event_bus.publish(
        channel,
        "estimate.ready",
        {"estimate_id": str(estimate.id), "version": estimate.version},
    )
    instrumentation.record_generation(
        job_id=str(job.id),
        duration_s=time.monotonic() - started,
        assemblies=len(output.assemblies),
        outside_scope=output.outside_supported_scope,
    )
    return estimate


def record_failure(
    db: Session, job_id: uuid.UUID, failure: GenerationFailure, event_bus: EventBus
) -> Estimate | None:
    """Persist a generation_failed estimate row with a user-safe reason."""
    job = db.get(Job, job_id)
    if job is None:
        return None
    estimate = Estimate(
        company_id=job.company_id,
        job_id=job.id,
        version=_next_version(db, job.id),
        status="generation_failed",
        source="ai",
        scope_prose=None,
        ai_output={"error": failure.user_message, "internal": failure.internal},
        totals={"subtotal": "0", "tax": "0", "total": "0"},
    )
    db.add(estimate)
    db.commit()
    db.refresh(estimate)
    event_bus.publish(
        job_channel(job.id),
        "generation.failed",
        {"estimate_id": str(estimate.id), "reason": failure.user_message},
    )
    logger.error(
        "generation_failed",
        extra={"job_id": str(job_id), "internal": failure.internal},
    )
    return estimate
