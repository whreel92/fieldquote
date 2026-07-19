"""Claude scoping model: single structured-output call with streaming.

The system prompt is versioned on disk (prompts/scoping_v1.md). Scope prose
streams to `on_prose` as it arrives (the mobile UX renders it live); the full
JSON is parsed and schema-validated at the end.
"""

import json
from pathlib import Path

import httpx

from fieldquote.ai.scoping.base import ProseCallback, ScopingError
from fieldquote.ai.types import ScopingContext, ScopingOutput

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-5"
PROMPT_VERSION = "scoping_v1"
PROMPT_PATH = Path(__file__).parent / "prompts" / f"{PROMPT_VERSION}.md"


def build_user_message(context: ScopingContext) -> str:
    parts: list[str] = [
        f"JOB: {context.job_title}",
        f"Contractor-selected job type: {context.job_type_code or 'not specified'}",
        f"Address: {context.job_address or 'not provided'}",
        "",
        "── DICTATION TRANSCRIPTS ──",
    ]
    audio = [c for c in context.captures if c.kind == "audio" and c.transcript]
    if audio:
        parts += [f"[capture {c.capture_id}] {c.transcript}" for c in audio]
    else:
        parts.append("(no dictation provided)")
    parts.append("")
    parts.append("── PHOTO FINDINGS (structured, one per photo) ──")
    photos = [c for c in context.captures if c.kind == "photo" and c.vision_findings]
    if photos:
        parts += [
            f"[capture {c.capture_id}] "
            + (c.vision_findings.model_dump_json() if c.vision_findings else "{}")
            for c in photos
        ]
    else:
        parts.append("(no photos provided)")
    parts.append("")
    parts.append(f"── VALID JOB TYPE CODES ──\n{', '.join(context.job_type_codes)}")
    parts.append(f"── VALID MODIFIER CODES ──\n{', '.join(context.modifier_codes)}")
    parts.append(
        "── ASSEMBLY CATALOG (code | name | unit | job types | allowed modifiers | tiers) ──"
    )
    parts += [
        f"{e.code} | {e.name} | {e.unit} | {','.join(e.job_type_codes)} | "
        f"{','.join(e.modifiers_allowed) or '-'} | "
        f"{'good/better/best' if e.has_option_tiers else '-'}"
        for e in context.catalog
    ]
    return "\n".join(parts)


class ClaudeScoping:
    name = "claude_scoping"

    def __init__(self, api_key: str, timeout_s: float = 180.0, model: str = MODEL) -> None:
        self._api_key = api_key
        self._timeout = timeout_s
        self._model = model
        self._system = PROMPT_PATH.read_text(encoding="utf-8")

    def scope(
        self,
        context: ScopingContext,
        *,
        on_prose: ProseCallback | None = None,
        repair_hint: str | None = None,
    ) -> ScopingOutput:
        messages = [{"role": "user", "content": build_user_message(context)}]
        if repair_hint:
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "Your previous output failed validation with these errors:\n"
                        f"{repair_hint}\n"
                        "Produce a corrected JSON object. Use ONLY codes from the catalog."
                    ),
                }
            )
        body = {
            "model": self._model,
            "max_tokens": 8192,
            "system": self._system,
            "messages": messages,
            "stream": True,
        }
        raw = self._stream(body, on_prose)
        try:
            data = json.loads(_strip_fences(raw))
        except json.JSONDecodeError as exc:
            raise ScopingError(f"Scoping output was not valid JSON: {exc}") from exc
        return ScopingOutput.model_validate(data)

    def _stream(self, body: dict[str, object], on_prose: ProseCallback | None) -> str:
        chunks: list[str] = []
        prose_streamer = _ProseStreamer(on_prose)
        try:
            with httpx.stream(
                "POST",
                ANTHROPIC_URL,
                json=body,
                headers={
                    "x-api-key": self._api_key,
                    "anthropic-version": "2023-06-01",
                },
                timeout=self._timeout,
            ) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    event = json.loads(line[6:])
                    if event.get("type") == "content_block_delta":
                        text = event.get("delta", {}).get("text", "")
                        if text:
                            chunks.append(text)
                            prose_streamer.feed(text)
        except httpx.HTTPError as exc:
            raise ScopingError(f"Claude scoping request failed: {exc}") from exc
        return "".join(chunks)


class _ProseStreamer:
    """Extracts the scope_prose string value from streaming JSON and forwards
    decoded text chunks. Best-effort — the authoritative value comes from the
    final parsed JSON."""

    _KEY = '"scope_prose"'

    def __init__(self, callback: ProseCallback | None) -> None:
        self._callback = callback
        self._buffer = ""
        self._in_prose = False
        self._done = False

    def feed(self, text: str) -> None:
        if self._callback is None or self._done:
            return
        self._buffer += text
        if not self._in_prose:
            idx = self._buffer.find(self._KEY)
            if idx == -1:
                return
            after = self._buffer[idx + len(self._KEY):]
            colon = after.find(":")
            if colon == -1:
                return
            quote = after.find('"', colon)
            if quote == -1:
                return
            self._buffer = after[quote + 1:]
            self._in_prose = True
        # Emit until an unescaped closing quote.
        out: list[str] = []
        i = 0
        while i < len(self._buffer):
            ch = self._buffer[i]
            if ch == "\\" and i + 1 < len(self._buffer):
                nxt = self._buffer[i + 1]
                out.append({"n": "\n", "t": "\t", '"': '"', "\\": "\\"}.get(nxt, nxt))
                i += 2
                continue
            if ch == "\\":
                break  # escape split across chunks — wait for more
            if ch == '"':
                self._done = True
                break
            out.append(ch)
            i += 1
        self._buffer = self._buffer[i:] if not self._done else ""
        if out:
            self._callback("".join(out))


def _strip_fences(text: str) -> str:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        cleaned = cleaned.rsplit("```", 1)[0]
    return cleaned.strip()
