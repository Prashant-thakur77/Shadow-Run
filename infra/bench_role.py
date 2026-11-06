#!/usr/bin/env python3
"""A separate role for the benchmark's throwaway databases. It can create databases and owns nothing else.

The benchmark never touches the demo prod database, and this role has no rights on it.
"""
from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parent))
from provision import load_env, reachable, set_env  # noqa: E402

ROLE = "shadow_bench"


def main() -> None:
    load_env()
    admin = dict(host=os.environ["SHADOWRUN_ADMIN_HOST"], port=os.environ["SHADOWRUN_ADMIN_PORT"], user=os.environ["SHADOWRUN_ADMIN_USER"], password=os.environ["SHADOWRUN_ADMIN_DB_PASSWORD"], dbname=os.environ["SHADOWRUN_ADMIN_DB"], sslmode="require")
    password = os.environ.get("SHADOWRUN_BENCH_PASSWORD") or secrets.token_urlsafe(24)
    with reachable(admin) as route, psycopg.connect(**route, autocommit=True) as c:
        if not c.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone():
            c.execute(f'CREATE ROLE "{ROLE}" LOGIN NOSUPERUSER CREATEDB NOCREATEROLE')
        c.execute(sql.SQL("ALTER ROLE {} PASSWORD {}").format(sql.Identifier(ROLE), sql.Literal(password)))
        c.execute('REVOKE CONNECT ON DATABASE "shadow_prod" FROM PUBLIC')
        c.execute('GRANT CONNECT ON DATABASE "shadow_prod" TO shadow_apply')
        print(c.execute("SELECT rolname, rolcreatedb, rolsuper FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone())
    set_env({
        "SHADOWRUN_BENCH_PASSWORD": password, "SHADOWRUN_BENCH_USER": ROLE,
        "SHADOWRUN_BENCH_HOST": os.environ.get("SHADOWRUN_PROD_VPC_HOST") or admin["host"], "SHADOWRUN_BENCH_PORT": str(admin["port"]), "SHADOWRUN_BENCH_DB": admin["dbname"],
    })


if __name__ == "__main__":
    main()
