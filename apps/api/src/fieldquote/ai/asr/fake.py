"""Fixture-backed ASR for tests — no network, deterministic."""

from fieldquote.ai.asr.base import ASRError
from fieldquote.ai.types import TranscriptResult


class FakeASR:
    name = "fake"

    def __init__(self, transcript: str | None = None, *, fail: bool = False) -> None:
        self._transcript = transcript
        self._fail = fail
        self.calls = 0

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptResult:
        self.calls += 1
        if self._fail:
            raise ASRError("FakeASR configured to fail")
        text = self._transcript if self._transcript is not None else audio.decode("utf-8")
        return TranscriptResult(text=text, confidence=0.99, provider=self.name)
