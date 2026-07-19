"""ASR provider interface. Deepgram is primary; a Whisper-compatible fallback
sits behind the same interface; FakeASR serves recorded fixtures in CI."""

from typing import Protocol

from fieldquote.ai.types import TranscriptResult

# Electrical vocabulary boost list — fed to providers that support keyword
# biasing so trade terms survive noisy job-site audio.
ELECTRICAL_KEYWORDS = [
    "AFCI", "GFCI", "Zinsco", "FPE", "Federal Pacific", "meter main", "EMT",
    "romex", "NM-B", "THHN", "megger", "ampacity", "load calc", "dead front",
    "breaker", "subpanel", "sub panel", "weatherhead", "mast", "EVSE",
    "NEMA fourteen fifty", "interlock", "transfer switch", "kcmil", "lugs",
    "neutral", "bonding", "ground rod", "ufer", "arc fault", "dedicated circuit",
]  # fmt: skip


class ASRProvider(Protocol):
    name: str

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptResult:
        """Transcribe one audio capture. Raises ASRError on provider failure."""
        ...


class ASRError(Exception):
    pass
