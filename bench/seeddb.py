"""Throwaway databases for the benchmark. A template per task, one fresh copy per run. Never demo prod."""
from __future__ import annotations

import uuid

import psycopg

from demo.seed import seed

# The demo schema cascades into its money tables on purpose, which is the trap most risky tasks are built on. Real billing
# schemas more often refuse. The RESTRICT variant asks how much of the result depends on that choice. Everything else stays.
MONEY_FOREIGN_KEYS = (
    ("invoices", "billing_user_id", "users"),
    ("invoices", "account_id", "accounts"),
    ("orders", "user_id", "users"),
    ("orders", "account_id", "accounts"),
    ("payments", "invoice_id", "invoices"),
    ("subscriptions", "account_id", "accounts"),
)


def _admin(admin: dict):
    return psycopg.connect(**{**admin, "dbname": admin.get("maintenance_db", "postgres") if "maintenance_db" in admin else admin["dbname"]}, autocommit=True)


def restrict_money_fks(conn) -> None:
    """Rebuild the money tables' foreign keys with ON DELETE RESTRICT, keeping their names. Runs in the caller's transaction."""
    for table, column, parent in MONEY_FOREIGN_KEYS:
        name = conn.execute(
            "SELECT k.conname FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey) "
            "WHERE k.contype = 'f' AND k.conrelid = %s::regclass AND a.attname = %s",
            (table, column),
        ).fetchone()[0]
        conn.execute(f'ALTER TABLE {table} DROP CONSTRAINT "{name}"')
        conn.execute(f'ALTER TABLE {table} ADD CONSTRAINT "{name}" FOREIGN KEY ({column}) REFERENCES {parent} (id) ON DELETE RESTRICT')


def make_template(admin: dict, task: dict, *, restrict_fks: bool = False) -> str:
    name = f"bt_{uuid.uuid4().hex[:12]}"
    with _admin(admin) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    kw = {**admin, "dbname": name}
    with psycopg.connect(**kw) as c:
        demo = task.get("base", "demo") == "demo"
        if demo:
            seed(c)
        if task.get("seed_sql"):
            c.execute(task["seed_sql"])
        if restrict_fks and demo:
            restrict_money_fks(c)
        c.commit()
        c.execute("ANALYZE")
        c.commit()
    return name


def new_db_from_template(admin: dict, template: str) -> str:
    name = f"b_{uuid.uuid4().hex[:12]}"
    with _admin(admin) as c:
        c.execute(f'CREATE DATABASE "{name}" TEMPLATE "{template}"')
    return name


def drop_db(admin: dict, name: str, is_template: bool = False) -> None:
    with _admin(admin) as c:
        c.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
