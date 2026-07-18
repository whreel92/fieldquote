import os
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-jwt-secret-for-unit-tests-only")

from fieldquote.core.config import get_settings
from fieldquote.main import create_app

TEST_SECRET = "test-jwt-secret-for-unit-tests-only"


@pytest.fixture(scope="session")
def app() -> FastAPI:
    get_settings.cache_clear()
    return create_app()


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def make_token(
    user_id: str | None = None,
    email: str = "will@example.com",
    *,
    secret: str = TEST_SECRET,
    expires_in: int = 3600,
    audience: str = "authenticated",
) -> str:
    now = datetime.now(tz=UTC)
    claims = {
        "sub": user_id or str(uuid.uuid4()),
        "email": email,
        "aud": audience,
        "iat": now,
        "exp": now + timedelta(seconds=expires_in),
    }
    return jwt.encode(claims, secret, algorithm="HS256")
