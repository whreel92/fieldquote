"""Supabase Storage signed-upload URLs, behind an interface (CLAUDE.md §0.1.10).

The real implementation calls the Storage API with the service role key; tests
and unconfigured environments use `FakeStorage`.
"""

from dataclasses import dataclass
from typing import Protocol

import httpx

from fieldquote.core.config import get_settings


@dataclass(frozen=True)
class SignedUpload:
    """Client PUTs the file to `url` (absolute) with the given token."""

    path: str
    token: str
    url: str


class StorageService(Protocol):
    def create_signed_upload(self, bucket: str, path: str) -> SignedUpload: ...


class SupabaseStorage:
    def __init__(self, supabase_url: str, service_role_key: str) -> None:
        self._base = supabase_url.rstrip("/")
        self._key = service_role_key

    def create_signed_upload(self, bucket: str, path: str) -> SignedUpload:
        res = httpx.post(
            f"{self._base}/storage/v1/object/upload/sign/{bucket}/{path}",
            headers={"Authorization": f"Bearer {self._key}", "apikey": self._key},
            timeout=10,
        )
        res.raise_for_status()
        body = res.json()
        # API returns {"url": "/object/upload/sign/<bucket>/<path>?token=..."}
        return SignedUpload(
            path=path,
            token=str(body.get("token", "")),
            url=f"{self._base}/storage/v1{body['url']}",
        )


class FakeStorage:
    def create_signed_upload(self, bucket: str, path: str) -> SignedUpload:
        return SignedUpload(path=path, token="fake-token", url=f"fake://{bucket}/{path}")


def get_storage() -> StorageService:
    settings = get_settings()
    if settings.supabase_url and settings.supabase_service_role_key:
        return SupabaseStorage(settings.supabase_url, settings.supabase_service_role_key)
    return FakeStorage()
