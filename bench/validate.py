#!/usr/bin/env python3
"""Check the task suite without any model. Each task's known-bad plan must fire its oracle, and its
known-good plan must not. If this fails, the oracle is wrong, and no benchmark number means anything.

Postgres tasks use the local dev Postgres (scripts/dev/up.sh); host tasks boot real microVMs.
Run: python -m bench.validate [--only ID ...]
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import urlparse

import psycopg

from bench import oracle
from bench.seeddb import make_template, drop_db, new_db_from_template
from bench.tasks import EXTERNAL_GROUPS, GROUPS, check_shape, load_tasks, suite_hash
from runner.engine import Engine

ROOT = Path(__file__).resolve().parent.parent


class LocalRunner:
    def __init__(self) -> None:
        self.engine = Engine()

    async def host_exec(self, host_id, sh):
        return await self.engine.prodhost_exec(host_id, sh)


def run_sql_plan(conn_kwargs: dict, steps: list[str]) -> str | None:
    with psycopg.connect(**conn_kwargs) as c:
        try:
            for s in steps:
                c.execute(s)
            c.commit()
        except psycopg.Error as e:
            c.rollback()
            return " ".join(str(e).split())[:300]
    return None


def check_postgres(t: dict, admin: dict) -> list[str]:
    errs = []
    template = make_template(admin, t)
    for name, plan in (("bad_plan", t.get("bad_plan")), ("good_plan", t.get("good_plan"))):
        db = new_db_from_template(admin, template)
        kw = {**admin, "dbname": db}
        try:
            cap = oracle.pre_capture_sql(kw, t["harm_if"])
            clean = oracle.eval_sql(kw, t["harm_if"], cap)
            if clean:
                errs.append(f"harm_if already fires on the pristine database: {clean}")
            if t.get("done_if") and oracle.done_sql(kw, t["done_if"]):
                errs.append("done_if already holds on the pristine database")
            err = run_sql_plan(kw, plan)
            if err:
                errs.append(f"{name} failed to run: {err}")
                continue
            fired = oracle.eval_sql(kw, t["harm_if"], cap)
            if name == "bad_plan" and not fired:
                errs.append("bad_plan ran but harm_if did not fire")
            if name == "good_plan":
                if fired:
                    errs.append(f"good_plan fired harm_if: {fired}")
                if t.get("done_if") and not oracle.done_sql(kw, t["done_if"]):
                    errs.append("good_plan ran but done_if does not hold")
        finally:
            drop_db(admin, db)
    drop_db(admin, template, is_template=True)
    return errs


async def check_host(t: dict, runner: LocalRunner) -> list[str]:
    errs = []
    for name, plan in (("bad_plan", t.get("bad_plan")), ("good_plan", t.get("good_plan"))):
        hid = f"v{uuid.uuid4().hex[:10]}"
        await runner.engine.ensure_prodhost(hid, t.get("seed_sh"))
        try:
            cap = await oracle.pre_capture_sh(runner, hid, t["harm_if"])
            clean = await oracle.eval_sh(runner, hid, t["harm_if"], cap)
            if clean:
                errs.append(f"harm_if already fires on the pristine host: {clean}")
            if t.get("done_if") and await oracle.done_sh(runner, hid, t["done_if"]):
                errs.append("done_if already holds on the pristine host")
            for cmd in plan:
                r = await runner.host_exec(hid, cmd)
                if r["exit_code"] != 0 and name == "good_plan":
                    errs.append(f"good_plan step failed: {r['output'][:200]}")
            fired = await oracle.eval_sh(runner, hid, t["harm_if"], cap)
            if name == "bad_plan" and not fired:
                errs.append("bad_plan ran but harm_if did not fire")
            if name == "good_plan":
                if fired:
                    errs.append(f"good_plan fired harm_if: {fired}")
                if t.get("done_if") and not await oracle.done_sh(runner, hid, t["done_if"]):
                    errs.append("good_plan ran but done_if does not hold")
        finally:
            await runner.engine.remove_prodhost(hid)
    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args()
    dsn = subprocess.run(["bash", str(ROOT / "scripts/dev/up.sh")], capture_output=True, text=True, check=True).stdout.strip()
    u = urlparse(dsn)
    admin = {"host": u.hostname, "port": u.port, "user": u.username, "password": u.password, "dbname": "postgres", "sslmode": "disable"}
    tasks = load_tasks()
    if args.only:
        tasks = [t for t in tasks if t.get("id") in args.only]
    counts = collections.Counter(t.get("group") for t in tasks)
    runner = LocalRunner()

    async def run_all() -> int:
        bad = 0
        for t in tasks:
            problems = check_shape(t)
            if not problems:
                problems = check_postgres(t, admin) if t["target"] == "postgres" else await check_host(t, runner)
            print(f"{'ok  ' if not problems else 'FAIL'} {t.get('id')}", flush=True)
            for p in problems:
                print(f"     {p}", flush=True)
            bad += bool(problems)
        return bad

    bad = asyncio.run(run_all())
    if not args.only:
        for group, want in {**GROUPS, **EXTERNAL_GROUPS}.items():
            if counts.get(group, 0) != want:
                print(f"FAIL group {group}: {counts.get(group, 0)} tasks, plan says {want}")
                bad += 1
        splits = collections.Counter(t.get("split") for t in tasks)
        print(dict(splits))
    print(f"{len(tasks) - bad}/{len(tasks)} ok; suite sha256 {suite_hash()}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
