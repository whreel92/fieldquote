"""Job status machine (CLAUDE.md Phase 1). Pure — no I/O.

Forward flow: lead → estimating → sent → won → in_progress → complete → paid.
Any pre-won status may drop to lost; lost may reopen to lead. Everything else
is rejected — callers surface a 409 and log nothing.
"""

JOB_STATUSES = frozenset(
    {"lead", "estimating", "sent", "won", "lost", "in_progress", "complete", "paid"}
)

_ALLOWED: dict[str, frozenset[str]] = {
    "lead": frozenset({"estimating", "lost"}),
    "estimating": frozenset({"sent", "lost"}),
    "sent": frozenset({"won", "lost"}),
    "won": frozenset({"in_progress", "lost"}),
    "in_progress": frozenset({"complete"}),
    "complete": frozenset({"paid"}),
    "paid": frozenset(),
    "lost": frozenset({"lead"}),
}


def can_transition(current: str, target: str) -> bool:
    return target in _ALLOWED.get(current, frozenset())


def allowed_targets(current: str) -> frozenset[str]:
    return _ALLOWED.get(current, frozenset())
