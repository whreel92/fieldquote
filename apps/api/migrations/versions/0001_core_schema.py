"""core schema

Revision ID: 0001
Revises:
Create Date: 2026-07-18
"""

from collections.abc import Sequence
from pathlib import Path

from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Canonical SQL lives with the Supabase config so the CLI and Alembic apply
# the exact same file (ADR-0002).
SQL_FILE = (
    Path(__file__).resolve().parents[4]
    / "infra"
    / "supabase"
    / "migrations"
    / "20260718000000_core_schema.sql"
)


def upgrade() -> None:
    op.execute(SQL_FILE.read_text(encoding="utf-8"))


def downgrade() -> None:
    raise NotImplementedError("Phase 0 baseline migration is not reversible")
