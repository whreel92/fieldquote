"""Claude vision pass. Prompted to report ONLY what is visible; unknowns stay
null. Output is schema-validated; one repair retry on invalid JSON."""

import base64
import json

import httpx

from fieldquote.ai.types import VisionFindings
from fieldquote.ai.vision.base import VisionError

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-5"
PROMPT_VERSION = "vision_v1"

SYSTEM = """You are a residential electrical estimator's photo analyst.
Report ONLY what is clearly visible in the photo. If something is not visible
or not certain, use null or omit it — NEVER guess. Do not estimate prices,
hours, or costs. Respond with a single JSON object matching:

{
  "panel": {"brand": str|null, "amperage": int|null,
             "breaker_spaces_total": int|null, "breaker_spaces_free": int|null,
             "condition_flags": [str]} | null,
  "hazards": [str],
  "equipment": [str],
  "environment": {"exterior_type": str|null, "stories": int|null,
                   "location": str|null} | null,
  "ocr_text": [str],
  "confidence": "high"|"medium"|"low"
}

condition_flags examples: "rust", "double_tap", "scorching", "obsolete_brand",
"missing_knockout_fillers", "cloth_wiring". hazards are safety-relevant
observations. ocr_text is any legible label text. Respond with JSON only."""


class ClaudeVision:
    name = "claude_vision"

    def __init__(self, api_key: str, timeout_s: float = 60.0, model: str = MODEL) -> None:
        self._api_key = api_key
        self._timeout = timeout_s
        self._model = model

    def _call(self, image: bytes, content_type: str, extra: str = "") -> str:
        body = {
            "model": self._model,
            "max_tokens": 1024,
            "system": SYSTEM,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": content_type,
                                "data": base64.b64encode(image).decode("ascii"),
                            },
                        },
                        {"type": "text", "text": "Analyze this job-site photo." + extra},
                    ],
                }
            ],
        }
        try:
            response = httpx.post(
                ANTHROPIC_URL,
                json=body,
                headers={
                    "x-api-key": self._api_key,
                    "anthropic-version": "2023-06-01",
                },
                timeout=self._timeout,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise VisionError(f"Claude vision request failed: {exc}") from exc
        blocks = response.json().get("content", [])
        return "".join(block.get("text", "") for block in blocks if block.get("type") == "text")

    def analyze(self, image: bytes, content_type: str) -> VisionFindings:
        text = self._call(image, content_type)
        for attempt in range(2):
            try:
                data = json.loads(_strip_fences(text))
                data.pop("provider", None)
                return VisionFindings.model_validate({**data, "provider": self.name})
            except (json.JSONDecodeError, ValueError) as exc:
                if attempt == 1:
                    raise VisionError(f"Vision output failed validation: {exc}") from exc
                text = self._call(
                    image,
                    content_type,
                    f" Your previous reply was invalid ({exc}). Reply with valid JSON only.",
                )
        raise VisionError("unreachable")


def _strip_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        cleaned = cleaned.rsplit("```", 1)[0]
    return cleaned.strip()
