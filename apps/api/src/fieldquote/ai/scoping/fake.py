"""Fixture-backed scoping model for tests. Streams prose word-by-word so the
progressive UX path is exercised offline."""

from fieldquote.ai.scoping.base import ProseCallback, ScopingError
from fieldquote.ai.types import ScopingContext, ScopingOutput


class FakeScoping:
    name = "fake"

    def __init__(
        self,
        output: ScopingOutput,
        *,
        repaired_output: ScopingOutput | None = None,
        fail: bool = False,
    ) -> None:
        self._output = output
        self._repaired = repaired_output
        self._fail = fail
        self.calls = 0
        self.repair_hints: list[str] = []

    def scope(
        self,
        context: ScopingContext,
        *,
        on_prose: ProseCallback | None = None,
        repair_hint: str | None = None,
    ) -> ScopingOutput:
        self.calls += 1
        if self._fail:
            raise ScopingError("FakeScoping configured to fail")
        if repair_hint is not None:
            self.repair_hints.append(repair_hint)
        result = self._output
        if repair_hint is not None and self._repaired is not None:
            result = self._repaired
        if on_prose is not None:
            for word in result.scope_prose.split(" "):
                on_prose(word + " ")
        return result
