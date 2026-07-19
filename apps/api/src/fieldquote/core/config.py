from enum import StrEnum
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class AppEnv(StrEnum):
    development = "development"
    staging = "staging"
    production = "production"
    test = "test"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: AppEnv = AppEnv.development
    public_web_url: str = "http://localhost:3000"

    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = ""

    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:54322/postgres"
    redis_url: str = "redis://localhost:6379/0"

    anthropic_api_key: str = ""
    deepgram_api_key: str = ""

    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_connect_client_id: str = ""
    # Platform take on connected-account charges, in basis points (2.5% = 250).
    platform_fee_bps: int = 250
    revenuecat_api_key: str = ""

    # Feature flags for channels blocked on human dependencies (§0.1.10).
    sms_enabled: bool = False

    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_messaging_service_sid: str = ""
    resend_api_key: str = ""

    sentry_dsn_api: str = ""
    posthog_key: str = ""
    pdf_render_concurrency: int = 2


@lru_cache
def get_settings() -> Settings:
    return Settings()
