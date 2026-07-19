"""Shared AI pipeline types.

The scoping output schema is THE contract between the language model and the
pricing engine: the model maps input onto catalog codes; it NEVER emits a
price (§0.1.1). Everything here is Pydantic-validated before any downstream
use, and unknown fields are rejected so prompt drift surfaces loudly.
"""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── ASR ──────────────────────────────────────────────────────────────────────


class TranscriptResult(_Strict):
    text: str
    confidence: float | None = None
    duration_s: float | None = None
    provider: str = "unknown"
    language: str | None = None


# ── Vision ───────────────────────────────────────────────────────────────────


class PanelFindings(_Strict):
    brand: str | None = None
    amperage: int | None = None
    breaker_spaces_total: int | None = None
    breaker_spaces_free: int | None = None
    condition_flags: list[str] = Field(default_factory=list)


class EnvironmentFindings(_Strict):
    exterior_type: str | None = None
    stories: int | None = None
    location: str | None = None  # e.g. "garage", "exterior wall", "closet"


class VisionFindings(_Strict):
    """Structured findings for ONE photo. Only what is visible — unknowns are
    null, never guessed."""

    panel: PanelFindings | None = None
    hazards: list[str] = Field(default_factory=list)
    equipment: list[str] = Field(default_factory=list)
    environment: EnvironmentFindings | None = None
    ocr_text: list[str] = Field(default_factory=list)
    confidence: Literal["high", "medium", "low"] = "medium"
    provider: str = "unknown"


# ── Scoping ──────────────────────────────────────────────────────────────────


class ScopedAssembly(_Strict):
    code: str
    qty: Decimal = Field(gt=0)
    modifiers: list[str] = Field(default_factory=list)
    selected_tier: Literal["good", "better", "best"] | None = None
    evidence: str = Field(
        min_length=1, description="Quote/paraphrase of the input that justifies this"
    )


class ScopedAllowance(_Strict):
    description: str
    suggested_amount_basis: Literal["labor_only", "verify"] = "verify"
    reason: str


class VerifyFlag(_Strict):
    item: str
    action: str


class CodeNote(_Strict):
    note: str
    customer_visible: bool = True


class ScopingOutput(_Strict):
    """The model's entire deliverable. No prices anywhere in this schema —
    that is intentional and load-bearing."""

    job_type_code: str
    assemblies: list[ScopedAssembly] = Field(default_factory=list)
    allowances: list[ScopedAllowance] = Field(default_factory=list)
    verify_flags: list[VerifyFlag] = Field(default_factory=list)
    code_notes: list[CodeNote] = Field(default_factory=list)
    scope_prose: str
    questions_for_contractor: list[str] = Field(default_factory=list)
    # Graceful out-of-scope path ("paint my fence"): no assemblies, this set.
    outside_supported_scope: bool = False
    outside_reason: str | None = None


class CaptureInput(_Strict):
    """One capture's contribution to the scoping context."""

    capture_id: str
    kind: Literal["photo", "audio"]
    transcript: str | None = None
    vision_findings: VisionFindings | None = None


class CatalogSummaryEntry(_Strict):
    code: str
    name: str
    unit: str
    job_type_codes: list[str]
    modifiers_allowed: list[str]
    has_option_tiers: bool


class ScopingContext(_Strict):
    job_title: str
    job_type_code: str | None
    job_address: str | None = None
    company_trade: str = "electrical"
    captures: list[CaptureInput]
    catalog: list[CatalogSummaryEntry]
    modifier_codes: list[str]
    job_type_codes: list[str]


class GenerationFailure(Exception):  # noqa: N818 — domain term, not an "error"
    """Raised when the pipeline cannot produce a valid draft. `user_message`
    is safe to show contractors; raw model errors never surface (§Phase 3.5)."""

    def __init__(self, user_message: str, *, internal: str | None = None) -> None:
        super().__init__(user_message)
        self.user_message = user_message
        self.internal = internal or user_message
