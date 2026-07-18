from fastapi import APIRouter
from pydantic import BaseModel

from fieldquote import __version__

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: str
    version: str


@router.get("/health")
def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)
