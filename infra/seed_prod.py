#!/usr/bin/env python3
"""Create a least-privilege role and database on Managed Postgres, then seed the demo prod.

Shadow Run's apply role owns only this one database. The vultradmin login stays on the admin's
machine; the control plane gets the restricted role only.
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from provision import load_env, set_env  # noqa: E402

from demo.seed import seed  # noqa: E402

ROLE = "shadow_apply"
DB = "shadow_prod"


def main() -> None:
    load_env()
    admin = {
        "host": os.environ["SHADOWRUN_ADMIN_HOST"], "port": os.environ["SHADOWRUN_ADMIN_PORT"], "user": os.environ["SHADOWRUN_ADMIN_USER"],
        "password": os.environ["SHADOWRUN_ADMIN_DB_PASSWORD"], "dbname": os.environ["SHADOWRUN_ADMIN_DB"], "sslmode": "require",
    }
    apply_password = os.environ.get("SHADOWRUN_APPLY_PASSWORD") or secrets.token_urlsafe(24)
    with psycopg.connect(**admin, autocommit=True) as c:
        if not c.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone():
            c.execute(f'CREATE ROLE "{ROLE}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE')
        c.execute(psycopg.sql.SQL("ALTER ROLE {} PASSWORD {}").format(psycopg.sql.Identifier(ROLE), psycopg.sql.Literal(apply_password)))
        c.execute(f'GRANT "{ROLE}" TO CURRENT_USER')
        if not c.execute("SELECT 1 FROM pg_database WHERE datname=%s", (DB,)).fetchone():
            c.execute(f'CREATE DATABASE "{DB}" OWNER "{ROLE}"')
        print(c.execute("SELECT version()").fetchone()[0])
    set_env({"SHADOWRUN_APPLY_PASSWORD": apply_password, "SHADOWRUN_PROD_USER": ROLE, "SHADOWRUN_PROD_PASSWORD": apply_password, "SHADOWRUN_PROD_DB": DB})
    target = {**admin, "user": ROLE, "password": apply_password, "dbname": DB}
    with psycopg.connect(**target, autocommit=True) as c:
        c.execute("DROP SCHEMA IF EXISTS public CASCADE")
        c.execute("CREATE SCHEMA public")
    with psycopg.connect(**target) as c:
        counts = seed(c)
    print({k: v for k, v in counts.items()})


if __name__ == "__main__":
    import psycopg.sql  # noqa: F401

    main()
