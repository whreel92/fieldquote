"""Checklist mode: reviews a draft estimate's line set for missing work.

Same never-prices contract as scoping. Invalid catalog codes are filtered
(not repaired — suggestions are advisory, a short list is fine)."""

import json
from pathlib import Path
from typing import Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field

from fieldquote.ai.scoping.claude import _strip_fences, build_user_message
from fieldquote.ai.types import ScopingContext

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-5"
CHECKLIST_PROMPT_VERSION = "checklist_v1"
PROMPT_PATH = Path(__file__).parent / "prompts" / f"{CHECKLIST_PROMPT_VERSION}.md"


class Suggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    assembly_code: str | None = None
    description: str
    reason: str


class ChecklistOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    suggestions: list[Suggestion] = Field(default_factory=list, max_length=5)


class ChecklistModel(Protocol):
    name: str

    def review(self, context: ScopingContext, current_lines: list[str]) -> ChecklistOutput: ...


class ChecklistError(Exception):
    pass


class ClaudeChecklist:
    name = "claude_checklist"

    def __init__(self, api_key: str, timeout_s: float = 90.0, model: str = MODEL) -> None:
        self._api_key = api_key
        self._timeout = timeout_s
        self._model = model
        self._system = PROMPT_PATH.read_text(encoding="utf-8")

    def review(self, context: ScopingContext, current_lines: list[str]) -> ChecklistOutput:
        message = (
            build_user_message(context)
            + "\n\n── CURRENT ESTIMATE LINES ──\n"
            + "\n".join(f"- {line}" for line in current_lines)
        )
        try:
            response = httpx.post(
                ANTHROPIC_URL,
                json={
                    "model": self._model,
                    "max_tokens": 2048,
                    "system": self._system,
                    "messages": [{"role": "user", "content": message}],
                },
                headers={
                    "x-api-key": self._api_key,
                    "anthropic-version": "2023-06-01",
                },
                timeout=self._timeout,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ChecklistError(f"Checklist request failed: {exc}") from exc
        blocks = response.json().get("content", [])
        text = "".join(block.get("text", "") for block in blocks if block.get("type") == "text")
        try:
            return ChecklistOutput.model_validate(json.loads(_strip_fences(text)))
        except (json.JSONDecodeError, ValueError) as exc:
            raise ChecklistError(f"Checklist output invalid: {exc}") from exc


class FakeChecklist:
    name = "fake"

    def __init__(self, output: ChecklistOutput | None = None, *, fail: bool = False) -> None:
        self._output = output or ChecklistOutput()
        self._fail = fail
        self.calls = 0

    def review(self, context: ScopingContext, current_lines: list[str]) -> ChecklistOutput:
        self.calls += 1
        if self._fail:
            raise ChecklistError("FakeChecklist configured to fail")
        return self._output
