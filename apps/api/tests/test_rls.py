"""RLS isolation tests against a live Postgres (CLAUDE.md §0.1.6).

Run via scripts/test_rls.sh (starts a throwaway postgres:15 container) or set
FQ_RLS_DB_URL to any empty Postgres and run: uv run pytest -m rls
Simulates Supabase's model: SET ROLE authenticated + request.jwt.claim.sub GUC.
"""

import os
import uuid
from collections.abc import Iterator

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection, create_engine, text

pytestmark = pytest.mark.rls

DB_URL = os.environ.get("FQ_RLS_DB_URL", "")
if not DB_URL:
    pytest.skip("FQ_RLS_DB_URL not set (use scripts/test_rls.sh)", allow_module_level=True)

TENANT_TABLES = [
    "companies", "users", "clients", "jobs", "captures", "estimates", "estimate_lines",
    "proposals", "signatures", "invoices", "payments", "followup_sequences",
    "followup_events", "job_actuals", "audit_log", "company_rates", "subscriptions",
]  # fmt: skip

COMPANY_A = uuid.UUID("11111111-1111-1111-1111-111111111111")
COMPANY_B = uuid.UUID("22222222-2222-2222-2222-222222222222")
USER_A = uuid.UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
USER_B = uuid.UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")


@pytest.fixture(scope="module")
def admin() -> Iterator[Connection]:
    os.environ["DATABASE_URL"] = DB_URL
    cfg = Config("alembic.ini")
    command.upgrade(cfg, "head")

    engine = create_engine(DB_URL)
    with engine.begin() as conn:
        # Idempotent for local container reuse (FK cascades clean children).
        conn.execute(
            text("delete from companies where id in (:ca, :cb)"),
            {"ca": COMPANY_A, "cb": COMPANY_B},
        )
        conn.execute(
            text(
                """
                insert into companies (id, name) values
                  (:ca, 'Company A'), (:cb, 'Company B');
                """
            ),
            {"ca": COMPANY_A, "cb": COMPANY_B},
        )
        conn.execute(
            text(
                """
                insert into users (id, company_id, role, name) values
                  (:ua, :ca, 'owner', 'Alice'), (:ub, :cb, 'owner', 'Bob');
                """
            ),
            {"ua": USER_A, "ca": COMPANY_A, "ub": USER_B, "cb": COMPANY_B},
        )
        params = {"ca": COMPANY_A, "cb": COMPANY_B}
        conn.execute(
            text(
                "insert into clients (company_id, name) values"
                " (:ca, 'Client of A'), (:cb, 'Client of B')"
            ),
            params,
        )
        conn.execute(
            text(
                "insert into jobs (company_id, title) values (:ca, 'Job of A'), (:cb, 'Job of B')"
            ),
            params,
        )
    with engine.connect() as conn:
        yield conn
    engine.dispose()


@pytest.fixture
def as_user(admin: Connection) -> Iterator[Connection]:
    """Connection impersonating Supabase's `authenticated` role. Rolls back after."""
    admin.execute(text("begin"))
    admin.execute(text("set local role authenticated"))
    yield admin
    admin.execute(text("rollback"))


def _login(conn: Connection, user_id: uuid.UUID) -> None:
    conn.execute(
        text("select set_config('request.jwt.claim.sub', :uid, true)"), {"uid": str(user_id)}
    )


def test_rls_enabled_on_every_tenant_table(admin: Connection) -> None:
    rows = admin.execute(
        text(
            """
            select c.relname, c.relrowsecurity from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
            """
        )
    ).tuples()
    security: dict[str, bool] = {str(name): bool(enabled) for name, enabled in rows}
    missing = [t for t in TENANT_TABLES if not security.get(t)]
    assert not missing, f"RLS not enabled on: {missing}"


def test_cross_tenant_select_blocked(as_user: Connection) -> None:
    _login(as_user, USER_A)
    companies = as_user.execute(text("select id from companies")).scalars().all()
    assert companies == [COMPANY_A]
    clients = as_user.execute(text("select name from clients")).scalars().all()
    assert clients == ["Client of A"]
    jobs = as_user.execute(text("select title from jobs")).scalars().all()
    assert jobs == ["Job of A"]


def test_other_tenant_sees_only_their_rows(as_user: Connection) -> None:
    _login(as_user, USER_B)
    clients = as_user.execute(text("select name from clients")).scalars().all()
    assert clients == ["Client of B"]


def test_no_jwt_sees_nothing(as_user: Connection) -> None:
    for table in ("companies", "users", "clients", "jobs"):
        count = as_user.execute(text(f"select count(*) from {table}")).scalar()
        assert count == 0, f"anonymous session read rows from {table}"


def test_cross_tenant_insert_blocked(as_user: Connection) -> None:
    _login(as_user, USER_A)
    with pytest.raises(Exception, match="row-level security"):
        as_user.execute(
            text("insert into clients (company_id, name) values (:cb, 'sneaky')"),
            {"cb": COMPANY_B},
        )


def test_same_tenant_insert_allowed(as_user: Connection) -> None:
    _login(as_user, USER_A)
    as_user.execute(
        text("insert into clients (company_id, name) values (:ca, 'legit')"),
        {"ca": COMPANY_A},
    )
    names = as_user.execute(text("select name from clients order by name")).scalars().all()
    assert names == ["Client of A", "legit"]


def test_cross_tenant_update_invisible(as_user: Connection) -> None:
    _login(as_user, USER_B)
    result = as_user.execute(text("update jobs set title = 'hacked' where title = 'Job of A'"))
    assert result.rowcount == 0


def test_pricing_catalog_read_only(as_user: Connection) -> None:
    _login(as_user, USER_A)
    as_user.execute(text("select count(*) from assemblies")).scalar()
    with pytest.raises(Exception, match="permission denied"):
        as_user.execute(
            text(
                "insert into assemblies (code, name, labor_hours) values ('X', 'X', 1)"
            )
        )
