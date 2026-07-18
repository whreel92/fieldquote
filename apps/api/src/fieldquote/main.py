import logging

import sentry_sdk
from fastapi import FastAPI

from fieldquote import __version__
from fieldquote.core.config import get_settings
from fieldquote.core.errors import register_error_handlers
from fieldquote.core.logging import configure_logging
from fieldquote.routers import health, me


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(logging.DEBUG if settings.app_env == "development" else logging.INFO)
    if settings.sentry_dsn_api:
        sentry_sdk.init(
            dsn=settings.sentry_dsn_api,
            environment=settings.app_env.value,
            traces_sample_rate=0.1,
        )

    app = FastAPI(title="FieldQuote API", version=__version__)
    register_error_handlers(app)
    app.include_router(health.router)
    app.include_router(me.router)
    return app


app = create_app()
