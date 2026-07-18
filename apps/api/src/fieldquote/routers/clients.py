import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from fieldquote.core.db import get_db
from fieldquote.core.errors import NotFoundError
from fieldquote.core.tenancy import TenantContext, get_current_context
from fieldquote.domain.models import Client
from fieldquote.services import audit

router = APIRouter(tags=["clients"])

Ctx = Annotated[TenantContext, Depends(get_current_context)]
Db = Annotated[Session, Depends(get_db)]


class ClientOut(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    email: str | None
    address: str | None
    notes: str | None
    created_at: datetime


class ClientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=254)
    address: str | None = Field(default=None, max_length=500)
    notes: str | None = Field(default=None, max_length=5000)


class ClientPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    phone: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=254)
    address: str | None = Field(default=None, max_length=500)
    notes: str | None = Field(default=None, max_length=5000)


def _out(c: Client) -> ClientOut:
    return ClientOut(
        id=c.id,
        name=c.name,
        phone=c.phone,
        email=c.email,
        address=c.address,
        notes=c.notes,
        created_at=c.created_at,
    )


def _get_owned(db: Session, ctx: TenantContext, client_id: uuid.UUID) -> Client:
    client = db.get(Client, client_id)
    if client is None or client.company_id != ctx.company.id:
        raise NotFoundError("Client not found.")
    return client


@router.get("/clients")
def list_clients(
    ctx: Ctx,
    db: Db,
    search: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> list[ClientOut]:
    stmt = select(Client).where(Client.company_id == ctx.company.id)
    if search:
        pattern = f"%{search}%"
        stmt = stmt.where(
            or_(
                Client.name.ilike(pattern),
                Client.phone.ilike(pattern),
                Client.email.ilike(pattern),
            )
        )
    stmt = stmt.order_by(Client.name).limit(limit)
    return [_out(c) for c in db.scalars(stmt)]


@router.post("/clients", status_code=201)
def create_client(body: ClientIn, ctx: Ctx, db: Db) -> ClientOut:
    client = Client(company_id=ctx.company.id, **body.model_dump())
    db.add(client)
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="client",
        entity_id=client.id,
        action="create",
        after=body.model_dump(mode="json"),
    )
    db.commit()
    db.refresh(client)
    return _out(client)


@router.get("/clients/{client_id}")
def get_client(client_id: uuid.UUID, ctx: Ctx, db: Db) -> ClientOut:
    return _out(_get_owned(db, ctx, client_id))


@router.patch("/clients/{client_id}")
def update_client(client_id: uuid.UUID, patch: ClientPatch, ctx: Ctx, db: Db) -> ClientOut:
    client = _get_owned(db, ctx, client_id)
    changes = patch.model_dump(exclude_unset=True)
    before = {k: getattr(client, k) for k in changes}
    for key, value in changes.items():
        setattr(client, key, value)
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="client",
        entity_id=client.id,
        action="update",
        before=before,
        after=changes,
    )
    db.commit()
    db.refresh(client)
    return _out(client)


@router.delete("/clients/{client_id}", status_code=204)
def delete_client(client_id: uuid.UUID, ctx: Ctx, db: Db) -> None:
    client = _get_owned(db, ctx, client_id)
    audit.record(
        db,
        company_id=ctx.company.id,
        actor_id=ctx.user.id,
        entity="client",
        entity_id=client.id,
        action="delete",
        before={"name": client.name},
    )
    db.delete(client)
    db.commit()
