"""Unit tests for the production advisor-approved guard (no DB needed)."""

import uuid
from unittest.mock import patch

from fieldquote.core.config import AppEnv, Settings
from fieldquote.domain.models import Company
from fieldquote.services.catalog import approved_only, company_region


def _company(settings: dict[str, object] | None = None) -> Company:
    return Company(id=uuid.uuid4(), name="Test Co", settings=settings or {})


def _with_env(env: AppEnv) -> Settings:
    return Settings(app_env=env, supabase_jwt_secret="x")


def test_production_without_dev_mode_is_restricted() -> None:
    with patch(
        "fieldquote.services.catalog.get_settings", return_value=_with_env(AppEnv.production)
    ):
        assert approved_only(_company()) is True


def test_production_with_dev_mode_is_unrestricted() -> None:
    with patch(
        "fieldquote.services.catalog.get_settings", return_value=_with_env(AppEnv.production)
    ):
        assert approved_only(_company({"dev_mode": True})) is False


def test_development_is_unrestricted() -> None:
    with patch(
        "fieldquote.services.catalog.get_settings", return_value=_with_env(AppEnv.development)
    ):
        assert approved_only(_company()) is False


def test_staging_is_unrestricted() -> None:
    with patch(
        "fieldquote.services.catalog.get_settings", return_value=_with_env(AppEnv.staging)
    ):
        assert approved_only(_company()) is False


def test_company_region_default_and_setting() -> None:
    assert company_region(_company()) == "default"
    assert company_region(_company({"region": "west"})) == "west"
