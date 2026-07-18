import uuid
from typing import Any

from sqlalchemy.orm import Session

from fieldquote.domain.models import AuditLog


def record(
    db: Session,
    *,
    company_id: uuid.UUID,
    actor_id: uuid.UUID | None,
    entity: str,
    entity_id: uuid.UUID | None,
    action: str,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    """Append an audit row in the caller's transaction (committed with it)."""
    db.add(
        AuditLog(
            company_id=company_id,
            actor_id=actor_id,
            entity=entity,
            entity_id=entity_id,
            action=action,
            before=before,
            after=after,
        )
    )
