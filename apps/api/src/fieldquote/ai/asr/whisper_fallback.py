"""Whisper fallback ASR.

Runs a local whisper-compatible CLI (whisper.cpp, faster-whisper CLI, or
openai-whisper) when Deepgram is unavailable. Configured via WHISPER_CMD —
a command template receiving the audio file path, expected to print the
transcript to stdout. Behind the same interface so the orchestrator can fail
over transparently; unconfigured instances raise ASRError and the pipeline
surfaces a friendly retry.
"""

import os
import shlex
import subprocess
import tempfile

from fieldquote.ai.asr.base import ASRError
from fieldquote.ai.types import TranscriptResult

_SUFFIX = {"audio/m4a": ".m4a", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/mpeg": ".mp3"}


class WhisperFallbackASR:
    name = "whisper_fallback"

    def __init__(self, command_template: str | None = None, timeout_s: float = 300.0) -> None:
        self._template = command_template or os.environ.get("WHISPER_CMD", "")
        self._timeout = timeout_s

    def transcribe(self, audio: bytes, content_type: str) -> TranscriptResult:
        if not self._template:
            raise ASRError("Whisper fallback is not configured (set WHISPER_CMD).")
        suffix = _SUFFIX.get(content_type, ".m4a")
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(audio)
            path = handle.name
        try:
            command = [
                part.replace("{path}", path) for part in shlex.split(self._template)
            ]
            result = subprocess.run(
                command, capture_output=True, text=True, timeout=self._timeout, check=False
            )
            if result.returncode != 0:
                raise ASRError(f"Whisper exited {result.returncode}: {result.stderr[:500]}")
            return TranscriptResult(text=result.stdout.strip(), provider=self.name)
        except subprocess.TimeoutExpired as exc:
            raise ASRError("Whisper transcription timed out.") from exc
        finally:
            os.unlink(path)
