"""Scoping model interface."""

from collections.abc import Callable
from typing import Protocol

from fieldquote.ai.types import ScopingContext, ScopingOutput

# Called with each streamed chunk of scope prose for the progressive UX.
ProseCallback = Callable[[str], None]


class ScopingModel(Protocol):
    name: str

    def scope(
        self,
        context: ScopingContext,
        *,
        on_prose: ProseCallback | None = None,
        repair_hint: str | None = None,
    ) -> ScopingOutput:
        """Map context onto the catalog. `repair_hint` carries validation
        errors from a failed attempt for the single repair retry.
        Raises ScopingError on provider failure."""
        ...


class ScopingError(Exception):
    pass
