"""Deepgram ASR (primary provider)."""

import httpx

from fieldquote.ai.asr.base import ELECTRICAL_KEYWORDS, ASRError
from fieldquote.ai.types import TranscriptResult

DEEPGRAM_URL = "https://api.deepgram.com/v1/listen"


class DeepgramASR:
    name = "deepgram"

    def __init__(self, api_key: str, timeout_s: float = 60.0) -> None:
        self._api_key = api_key
        self._timeout = timeout_s

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptResult:
        params: list[tuple[str, str | int | float | bool | None]] = [
            ("model", "nova-3"),
            ("smart_format", "true"),
            ("detect_language", "true"),
        ]
        params += [("keyterm", term) for term in ELECTRICAL_KEYWORDS]
        try:
            response = httpx.post(
                DEEPGRAM_URL,
                params=params,
                content=audio,
                headers={
                    "Authorization": f"Token {self._api_key}",
                    "Content-Type": content_type,
                },
                timeout=self._timeout,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ASRError(f"Deepgram request failed: {exc}") from exc

        payload = response.json()
        try:
            channel = payload["results"]["channels"][0]
            alternative = channel["alternatives"][0]
            return TranscriptResult(
                text=alternative["transcript"],
                confidence=alternative.get("confidence"),
                duration_s=payload.get("metadata", {}).get("duration"),
                provider=self.name,
                language=channel.get("detected_language"),
            )
        except (KeyError, IndexError) as exc:
            raise ASRError(f"Unexpected Deepgram response shape: {exc}") from exc
