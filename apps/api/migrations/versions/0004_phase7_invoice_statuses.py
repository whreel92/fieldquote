"""phase 7 invoice statuses (partial, refunded)

Revision ID: 0004
Revises: 0003
Create Date: 2026-07-19
"""

from collections.abc import Sequence
from pathlib import Path

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SQL_FILE = (
    Path(__file__).resolve().parents[4]
    / "infra"
    / "supabase"
    / "migrations"
    / "20260721000000_phase7_invoice_statuses.sql"
)


def upgrade() -> None:
    op.execute(SQL_FILE.read_text(encoding="utf-8"))


def downgrade() -> None:
    raise NotImplementedError("Phase 7 migration is not reversible")
