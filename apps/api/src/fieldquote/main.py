import logging

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from fieldquote import __version__
from fieldquote.core.config import AppEnv, get_settings
from fieldquote.core.errors import register_error_handlers
from fieldquote.core.logging import configure_logging
from fieldquote.routers import (
    captures,
    catalog,
    clients,
    company,
    estimates,
    health,
    jobs,
    me,
    pricing,
    proposals,
    public,
    stripe_connect,
    webhooks,
)


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
    origins = [settings.public_web_url]
    if settings.app_env in (AppEnv.development, AppEnv.test):
        # Expo web dev server + Next dev server.
        origins += ["http://localhost:8081", "http://localhost:19006", "http://localhost:3000"]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(set(origins)),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    app.include_router(health.router)
    app.include_router(me.router)
    app.include_router(company.router)
    app.include_router(clients.router)
    app.include_router(jobs.router)
    app.include_router(catalog.router)
    app.include_router(pricing.router)
    app.include_router(captures.router)
    app.include_router(estimates.router)
    app.include_router(proposals.router)
    app.include_router(public.router)
    app.include_router(stripe_connect.router)
    app.include_router(webhooks.router)
    return app


app = create_app()
