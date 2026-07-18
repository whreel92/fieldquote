import uuid
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from fieldquote.core.tenancy import TenantContext, get_current_context

router = APIRouter(tags=["account"])


class CompanyOut(BaseModel):
    id: uuid.UUID
    name: str
    trade: str
    timezone: str


class UserOut(BaseModel):
    id: uuid.UUID
    role: str
    name: str | None
    company: CompanyOut


@router.get("/me")
def me(ctx: Annotated[TenantContext, Depends(get_current_context)]) -> UserOut:
    return UserOut(
        id=ctx.user.id,
        role=ctx.user.role,
        name=ctx.user.name,
        company=CompanyOut(
            id=ctx.company.id,
            name=ctx.company.name,
            trade=ctx.company.trade,
            timezone=ctx.company.timezone,
        ),
    )
