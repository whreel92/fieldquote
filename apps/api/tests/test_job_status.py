from fieldquote.domain.job_status import JOB_STATUSES, allowed_targets, can_transition

EXPECTED = {
    ("lead", "estimating"), ("lead", "lost"),
    ("estimating", "sent"), ("estimating", "lost"),
    ("sent", "won"), ("sent", "lost"),
    ("won", "in_progress"), ("won", "lost"),
    ("in_progress", "complete"),
    ("complete", "paid"),
    ("lost", "lead"),
}  # fmt: skip


def test_exhaustive_transition_matrix() -> None:
    for current in JOB_STATUSES:
        for target in JOB_STATUSES:
            assert can_transition(current, target) == ((current, target) in EXPECTED), (
                f"{current} -> {target}"
            )


def test_paid_is_terminal() -> None:
    assert allowed_targets("paid") == frozenset()


def test_unknown_status_has_no_transitions() -> None:
    assert allowed_targets("bogus") == frozenset()
    assert not can_transition("bogus", "lead")
