"""Estimate editing: the server side of the Phase 5 editor.

Every mutation is deterministic and audit-logged. Engine-backed edits (qty,
modifiers, margin slider) re-run the pricing engine; manual overrides mark
the line `price_source: manual` with per-field `edited` badges. Approved
estimates are IMMUTABLE — mutations 409 with `fork_required`; a fork copies
the estimate into v(n+1) draft (§0.1.3 versioning + §Phase 5.8).
"""

import json
import uuid
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from fieldquote.core.errors import ConflictError, NotFoundError
from fieldquote.domain.models import Company, Estimate, EstimateLine, User
from fieldquote.pricing import Catalog, PricingRequest, price
from fieldquote.services.catalog import load_catalog, load_company_rates

CENT = Decimal("0.01")
PCT_STEP = Decimal("0.1")


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def pricing_context(estimate: Estimate) -> dict[str, Any]:
    totals = estimate.totals or {}
    context = dict(totals.get("pricing_context", {}))
    context.setdefault("pct", "0")
    context.setdefault("tax_rate_pct", "0")
    context.setdefault("markup_model", "margin")
    context.setdefault("labor_rate", "0")
    context.setdefault("margin_floor_pct", "0")
    context.setdefault("region", "default")
    return context


def ensure_editable(estimate: Estimate) -> None:
    if estimate.status == "approved":
        raise ConflictError(
            "This estimate is approved and locked. Edit a new version instead.",
            details={"code": "fork_required"},
        )
    if estimate.status == "superseded":
        raise ConflictError(
            "This version has been superseded and is read-only.",
            details={"code": "read_only_version"},
        )


def apply_model(cost: Decimal, pct: Decimal, model: str) -> Decimal:
    if model == "markup":
        return money(cost * (1 + pct / 100))
    if pct >= 100:
        raise ConflictError("Margin must be below 100%.")
    return money(cost / (1 - pct / 100))


def line_overrides(line: EstimateLine) -> dict[str, bool]:
    return dict((line.totals or {}).get("overrides", {}))


def _line_cost(line: EstimateLine) -> Decimal | None:
    breakdown = (line.totals or {}).get("breakdown")
    if breakdown and breakdown.get("cost_total") is not None:
        return Decimal(str(breakdown["cost_total"]))
    return None


def engine_reprice_line(
    db: Session,
    company: Company,
    estimate: Estimate,
    line: EstimateLine,
    *,
    qty: Decimal | None = None,
    modifiers: list[str] | None = None,
    pct_override: Decimal | None = None,
    catalog: Catalog | None = None,
) -> None:
    """Re-run the engine for one assembly-backed line in place."""
    assert line.assembly_code is not None
    catalog = catalog or load_catalog(db, company)
    context = pricing_context(estimate)
    rates = load_company_rates(db, company)
    pct = pct_override if pct_override is not None else Decimal(str(context["pct"]))
    current_modifiers = modifiers
    if current_modifiers is None:
        breakdown = (line.totals or {}).get("breakdown") or {}
        current_modifiers = [
            application["code"]
            for application in breakdown.get("modifier_applications", [])
        ]
        current_modifiers = list(dict.fromkeys(current_modifiers))
    selected_tier = None
    if line.line_type.startswith("option_"):
        selected_tier = line.line_type.removeprefix("option_")
    request = PricingRequest.model_validate(
        {
            "assemblies": [
                {
                    "code": line.assembly_code,
                    "qty": qty if qty is not None else line.qty,
                    "modifiers": current_modifiers,
                    "selected_tier": selected_tier,
                }
            ],
            "company_rates": rates,
            "region": context["region"],
            "adjustments": {"margin_override_pct": str(pct)},
        }
    )
    priced = price(request, catalog)
    priced_line = next(
        pl for pl in priced.lines if pl.included and pl.assembly_code == line.assembly_code
    )
    line.qty = priced_line.qty
    line.material_cost = priced_line.material_cost
    line.labor_hours = priced_line.labor_hours
    line.labor_rate = priced_line.labor_rate
    line.price_source = "engine"
    existing = dict(line.totals or {})
    line.totals = {
        **existing,
        "unit_price": str(priced_line.unit_price),
        "total": str(priced_line.total),
        "included": existing.get("included", True),
        "breakdown": json.loads(priced_line.model_dump_json(include={"breakdown"}))["breakdown"],
        "overrides": {},
    }


def manual_override_line(
    estimate: Estimate,
    line: EstimateLine,
    *,
    unit_price: Decimal | None = None,
    labor_hours: Decimal | None = None,
    material_cost: Decimal | None = None,
    qty: Decimal | None = None,
) -> None:
    """Apply manual field overrides; the line becomes `manual` with badges."""
    context = pricing_context(estimate)
    overrides = line_overrides(line)
    if qty is not None:
        line.qty = qty
        overrides["qty"] = True
    if labor_hours is not None:
        line.labor_hours = labor_hours
        overrides["labor_hours"] = True
    if material_cost is not None:
        line.material_cost = material_cost
        overrides["material_cost"] = True

    totals = dict(line.totals or {})
    if unit_price is not None:
        overrides["unit_price"] = True
        total = money(unit_price * line.qty)
        totals["unit_price"] = str(money(unit_price))
        totals["total"] = str(total)
    elif labor_hours is not None or material_cost is not None:
        # Deterministic recompute from the edited components.
        rate = line.labor_rate if line.labor_rate is not None else Decimal(context["labor_rate"])
        cost = (line.material_cost or Decimal(0)) + money(
            (line.labor_hours or Decimal(0)) * rate
        )
        total = apply_model(cost, Decimal(str(context["pct"])), str(context["markup_model"]))
        totals["unit_price"] = str(money(total / line.qty))
        totals["total"] = str(total)
        breakdown = dict(totals.get("breakdown") or {})
        breakdown["cost_total"] = str(cost)
        breakdown["labor_cost"] = str(money((line.labor_hours or Decimal(0)) * rate))
        breakdown["material_cost"] = str(line.material_cost or Decimal(0))
        totals["breakdown"] = breakdown
    elif qty is not None:
        unit = Decimal(str(totals.get("unit_price", "0")))
        totals["total"] = str(money(unit * line.qty))
    totals["overrides"] = overrides
    line.totals = totals
    line.price_source = "manual"


def recompute_estimate_totals(estimate: Estimate, lines: list[EstimateLine]) -> None:
    context = pricing_context(estimate)
    tax_rate = Decimal(str(context["tax_rate_pct"]))
    subtotal = Decimal(0)
    cost_total = Decimal(0)
    price_basis = Decimal(0)
    subtotal_material = Decimal(0)
    for line in lines:
        totals = line.totals or {}
        if not totals.get("included", True):
            continue
        line_total = Decimal(str(totals.get("total", "0")))
        subtotal += line_total
        if line.line_type not in ("allowance", "verify"):
            cost = _line_cost(line)
            if cost is not None:
                cost_total += cost
                price_basis += line_total
        if line.material_cost is not None:
            subtotal_material += line.material_cost
    subtotal = money(subtotal)
    tax = money(subtotal * tax_rate / 100)
    effective = (
        ((price_basis - cost_total) / price_basis * 100).quantize(
            PCT_STEP, rounding=ROUND_HALF_UP
        )
        if price_basis > 0
        else Decimal(0)
    )
    floor = Decimal(str(context["margin_floor_pct"]))
    estimate.totals = {
        **(estimate.totals or {}),
        "subtotal": str(subtotal),
        "subtotal_material": str(money(subtotal_material)),
        "tax": str(tax),
        "total": str(money(subtotal + tax)),
        "margin_check": {
            "cost_total": str(money(cost_total)),
            "price_basis": str(money(price_basis)),
            "effective_margin_pct": str(effective),
            "target_margin_pct": str(context["pct"]),
            "below_target": effective < Decimal(str(context["pct"])),
            "below_floor": floor > 0 and effective < floor,
        },
    }


def next_position(lines: list[EstimateLine]) -> int:
    return max((line.position for line in lines), default=-1) + 1


def fork_estimate(db: Session, estimate: Estimate, actor: User) -> Estimate:
    """Copy an estimate into a new draft version (prior versions read-only)."""
    max_version = db.scalar(
        select(func.max(Estimate.version)).where(Estimate.job_id == estimate.job_id)
    )
    fork = Estimate(
        company_id=estimate.company_id,
        job_id=estimate.job_id,
        version=(max_version or 0) + 1,
        status="draft",
        source="duplicate",
        scope_prose=estimate.scope_prose,
        ai_output=estimate.ai_output,
        totals=dict(estimate.totals or {}),
    )
    db.add(fork)
    db.flush()
    for line in sorted(estimate.lines, key=lambda entry: entry.position):
        db.add(
            EstimateLine(
                company_id=line.company_id,
                estimate_id=fork.id,
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
                editable_note=line.editable_note,
                totals=dict(line.totals or {}),
            )
        )
    return fork


REQUIRED_CONFIRMATIONS = ("scope", "lines", "totals", "terms")


def approve_estimate(
    estimate: Estimate, actor: User, confirmations: dict[str, bool]
) -> None:
    """THE legal control (§0.1.2): section-by-section confirmation, recorded
    approver + timestamp. Nothing can be sent until this has happened."""
    if estimate.status == "approved":
        raise ConflictError("This estimate is already approved.")
    if estimate.status != "draft":
        raise ConflictError("Only draft estimates can be approved.")
    missing = [key for key in REQUIRED_CONFIRMATIONS if not confirmations.get(key)]
    if missing:
        raise ConflictError(
            "Review every section before approving.",
            details={"missing_confirmations": missing},
        )
    estimate.status = "approved"
    estimate.approved_by = actor.id
    estimate.approved_at = datetime.now(tz=UTC)


def diff_estimates(a: Estimate, b: Estimate) -> dict[str, Any]:
    """Line diff between two versions, keyed by assembly_code/description."""

    def key(line: EstimateLine) -> str:
        return f"{line.assembly_code or ''}|{line.description}|{line.line_type}"

    def snapshot(line: EstimateLine) -> dict[str, Any]:
        return {
            "description": line.description,
            "line_type": line.line_type,
            "qty": str(line.qty),
            "total": str((line.totals or {}).get("total", "0")),
        }

    lines_a = {key(line): line for line in a.lines}
    lines_b = {key(line): line for line in b.lines}
    added = [snapshot(lines_b[k]) for k in lines_b.keys() - lines_a.keys()]
    removed = [snapshot(lines_a[k]) for k in lines_a.keys() - lines_b.keys()]
    changed = [
        {"before": snapshot(lines_a[k]), "after": snapshot(lines_b[k])}
        for k in lines_a.keys() & lines_b.keys()
        if snapshot(lines_a[k]) != snapshot(lines_b[k])
    ]
    return {
        "from_version": a.version,
        "to_version": b.version,
        "added": added,
        "removed": removed,
        "changed": changed,
        "totals": {
            "from": (a.totals or {}).get("total", "0"),
            "to": (b.totals or {}).get("total", "0"),
        },
    }


def get_owned_estimate(db: Session, company_id: uuid.UUID, estimate_id: uuid.UUID) -> Estimate:
    estimate = db.get(Estimate, estimate_id)
    if estimate is None or estimate.company_id != company_id:
        raise NotFoundError("Estimate not found.")
    return estimate


def get_owned_line(db: Session, estimate: Estimate, line_id: uuid.UUID) -> EstimateLine:
    line = db.get(EstimateLine, line_id)
    if line is None or line.estimate_id != estimate.id:
        raise NotFoundError("Line not found.")
    return line
