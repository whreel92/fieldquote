"""Tenant resolution: auth uid → users row → company.

`get_current_context` is the dependency every tenant-scoped router uses.
First authenticated call auto-provisions a company + owner user row
(mobile onboarding then fills in real details — Phase 1).
"""

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from fieldquote.core.auth import AuthContext, get_auth
from fieldquote.core.db import get_db
from fieldquote.core.errors import ForbiddenError
from fieldquote.domain.models import Company, User


@dataclass(frozen=True)
class TenantContext:
    user: User
    company: Company


def get_current_context(
    auth: Annotated[AuthContext, Depends(get_auth)],
    db: Annotated[Session, Depends(get_db)],
) -> TenantContext:
    user = db.scalar(select(User).where(User.id == auth.user_id))
    if user is None:
        company = Company(name=auth.email or "My Company", email=auth.email)
        user = User(id=auth.user_id, company=company, role="owner")
        db.add_all([company, user])
        db.commit()
        db.refresh(user)
    found = db.get(Company, user.company_id)
    if found is None:  # FK guarantees this can't happen outside data corruption
        raise RuntimeError(f"user {user.id} has no company row")
    return TenantContext(user=user, company=found)


def require_role(ctx: TenantContext, *roles: str) -> None:
    """Raise ForbiddenError unless the current user has one of the roles."""
    if ctx.user.role not in roles:
        raise ForbiddenError(
            "You don't have permission to do that.",
            details={"required_roles": sorted(roles)},
        )
