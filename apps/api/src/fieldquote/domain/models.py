"""SQLAlchemy ORM models.

Only the tables the API currently reads/writes are mapped here; the canonical
schema (all tables + RLS) lives in the SQL migration
(infra/supabase/migrations/0001_core_schema.sql). Models are added per phase.
"""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Company(Base):
    __tablename__ = "companies"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text)
    trade: Mapped[str] = mapped_column(Text, default="electrical")
    logo_url: Mapped[str | None] = mapped_column(Text)
    license_number: Mapped[str | None] = mapped_column(Text)
    insurance_line: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    address: Mapped[str | None] = mapped_column(Text)
    timezone: Mapped[str] = mapped_column(Text, default="America/Los_Angeles")
    settings: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    users: Mapped[list["User"]] = relationship(back_populates="company")


class User(Base):
    __tablename__ = "users"

    # Primary key is the Supabase auth uid.
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(16), default="owner")
    name: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    company: Mapped[Company] = relationship(back_populates="users")


class Client(Base):
    __tablename__ = "clients"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    address: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE")
    )
    client_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("clients.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default="lead")
    job_type_code: Mapped[str | None] = mapped_column(Text)
    address: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    client: Mapped[Client | None] = relationship()


class CompanyRate(Base):
    __tablename__ = "company_rates"

    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True
    )
    labor_rate: Mapped[Decimal] = mapped_column(Numeric, default=Decimal(0))
    helper_rate: Mapped[Decimal | None] = mapped_column(Numeric)
    target_margin_pct: Mapped[Decimal] = mapped_column(Numeric, default=Decimal(0))
    tax_rate_pct: Mapped[Decimal] = mapped_column(Numeric, default=Decimal(0))
    markup_model: Mapped[str] = mapped_column(String(16), default="margin")
    overrides: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class Capture(Base):
    __tablename__ = "captures"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE")
    )
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(Text)  # photo | audio
    storage_path: Mapped[str] = mapped_column(Text)
    duration_s: Mapped[Decimal | None] = mapped_column(Numeric)
    exif: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    transcript: Mapped[str | None] = mapped_column(Text)
    vision_findings: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    upload_state: Mapped[str] = mapped_column(Text, default="pending")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Estimate(Base):
    __tablename__ = "estimates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE")
    )
    job_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE")
    )
    version: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(Text, default="draft")
    source: Mapped[str] = mapped_column(Text, default="ai")
    scope_prose: Mapped[str | None] = mapped_column(Text)
    ai_output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    totals: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    lines: Mapped[list["EstimateLine"]] = relationship(
        back_populates="estimate", order_by="EstimateLine.position"
    )


class EstimateLine(Base):
    __tablename__ = "estimate_lines"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE")
    )
    estimate_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("estimates.id", ondelete="CASCADE")
    )
    position: Mapped[int] = mapped_column()
    assembly_code: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    qty: Mapped[Decimal] = mapped_column(Numeric, default=Decimal(1))
    unit: Mapped[str | None] = mapped_column(Text)
    material_cost: Mapped[Decimal | None] = mapped_column(Numeric)
    labor_hours: Mapped[Decimal | None] = mapped_column(Numeric)
    labor_rate: Mapped[Decimal | None] = mapped_column(Numeric)
    line_type: Mapped[str] = mapped_column(Text, default="standard")
    price_source: Mapped[str] = mapped_column(Text, default="engine")
    confidence: Mapped[str] = mapped_column(Text, default="known")
    editable_note: Mapped[str | None] = mapped_column(Text)
    totals: Mapped[dict[str, Any] | None] = mapped_column(JSONB)

    estimate: Mapped[Estimate] = relationship(back_populates="lines")


class MaterialItem(Base):
    """Global pricing catalog — not tenant-scoped."""

    __tablename__ = "material_items"

    sku: Mapped[str] = mapped_column(Text, primary_key=True)
    description: Mapped[str] = mapped_column(Text)
    unit: Mapped[str] = mapped_column(Text, default="ea")
    category: Mapped[str | None] = mapped_column(Text)
    base_price: Mapped[Decimal] = mapped_column(Numeric)
    price_asof: Mapped[datetime | None] = mapped_column(DateTime(timezone=False))
    source: Mapped[str | None] = mapped_column(Text)
    region_multipliers: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)


class Assembly(Base):
    """Global pricing catalog — not tenant-scoped."""

    __tablename__ = "assemblies"

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    trade: Mapped[str] = mapped_column(Text, default="electrical")
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    job_type_codes: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    unit: Mapped[str] = mapped_column(Text, default="ea")
    labor_hours: Mapped[Decimal] = mapped_column(Numeric)
    helper_hours: Mapped[Decimal] = mapped_column(Numeric, default=Decimal(0))
    labor_notes: Mapped[str | None] = mapped_column(Text)
    bom: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    modifiers_allowed: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    option_tiers: Mapped[list[dict[str, Any]] | None] = mapped_column(JSONB)
    version: Mapped[int] = mapped_column(default=1)
    status: Mapped[str] = mapped_column(Text, default="draft")


class Modifier(Base):
    """Global pricing catalog — not tenant-scoped."""

    __tablename__ = "modifiers"

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    effect: Mapped[dict[str, Any]] = mapped_column(JSONB)
    version: Mapped[int] = mapped_column(default=1)


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("companies.id", ondelete="CASCADE")
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    entity: Mapped[str] = mapped_column(Text)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    action: Mapped[str] = mapped_column(Text)
    before: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
