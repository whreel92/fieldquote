"""phase 2 assembly fields

Revision ID: 0002
Revises: 0001
Create Date: 2026-07-18
"""

from collections.abc import Sequence
from pathlib import Path

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SQL_FILE = (
    Path(__file__).resolve().parents[4]
    / "infra"
    / "supabase"
    / "migrations"
    / "20260719000000_phase2_assembly_fields.sql"
)


def upgrade() -> None:
    op.execute(SQL_FILE.read_text(encoding="utf-8"))


def downgrade() -> None:
    op.execute(
        "alter table public.assemblies drop column if exists option_tiers, "
        "drop column if exists helper_hours, drop column if exists unit"
    )
