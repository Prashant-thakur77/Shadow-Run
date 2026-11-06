"""Throwaway databases for the benchmark. A template per task, one fresh copy per run. Never demo prod."""
from __future__ import annotations

import uuid

import psycopg

from demo.seed import seed


def _admin(admin: dict):
    return psycopg.connect(**{**admin, "dbname": admin.get("maintenance_db", "postgres") if "maintenance_db" in admin else admin["dbname"]}, autocommit=True)


def make_template(admin: dict, task: dict) -> str:
    name = f"bt_{uuid.uuid4().hex[:12]}"
    with _admin(admin) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    kw = {**admin, "dbname": name}
    with psycopg.connect(**kw) as c:
        if task.get("base", "demo") == "demo":
            seed(c)
        if task.get("seed_sql"):
            c.execute(task["seed_sql"])
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
