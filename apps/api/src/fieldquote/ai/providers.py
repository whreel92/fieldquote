"""Provider factory: real providers when keys exist, loud failure otherwise.

Workers call `get_providers()`; tests construct `Providers` with fakes
directly. Missing keys are recorded in docs/HUMAN_TODO.md (§0.1.10)."""

from fieldquote.ai.asr.base import ASRProvider
from fieldquote.ai.asr.deepgram import DeepgramASR
from fieldquote.ai.asr.whisper_fallback import WhisperFallbackASR
from fieldquote.ai.scoping.claude import ClaudeScoping
from fieldquote.ai.vision.claude import ClaudeVision
from fieldquote.core.config import get_settings
from fieldquote.services.generation import Providers


class ProvidersNotConfiguredError(Exception):
    pass


def get_providers() -> Providers:
    settings = get_settings()
    if not settings.anthropic_api_key:
        raise ProvidersNotConfiguredError(
            "ANTHROPIC_API_KEY is not set — generation requires it (see docs/HUMAN_TODO.md)."
        )
    asr: ASRProvider
    if settings.deepgram_api_key:
        asr = DeepgramASR(settings.deepgram_api_key)
    else:
        # No Deepgram — promote the fallback to primary so dev still works.
        asr = WhisperFallbackASR()
    return Providers(
        asr=asr,
        asr_fallback=WhisperFallbackASR() if settings.deepgram_api_key else None,
        vision=ClaudeVision(settings.anthropic_api_key),
        scoping=ClaudeScoping(settings.anthropic_api_key),
    )
