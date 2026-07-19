"""Fixture-backed vision analyzer for tests."""

from fieldquote.ai.types import VisionFindings
from fieldquote.ai.vision.base import VisionError


class FakeVision:
    name = "fake"

    def __init__(self, findings: VisionFindings | None = None, *, fail: bool = False) -> None:
        self._findings = findings or VisionFindings(provider="fake")
        self._fail = fail
        self.calls = 0

    def analyze(self, image: bytes, content_type: str) -> VisionFindings:
        self.calls += 1
        if self._fail:
            raise VisionError("FakeVision configured to fail")
        return self._findings
