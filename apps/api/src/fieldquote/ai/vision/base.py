"""Vision analyzer interface: one photo in, structured findings out."""

from typing import Protocol

from fieldquote.ai.types import VisionFindings


class VisionAnalyzer(Protocol):
    name: str

    def analyze(self, image: bytes, content_type: str) -> VisionFindings:
        """Analyze one job-site photo. Raises VisionError on provider failure."""
        ...


class VisionError(Exception):
    pass
