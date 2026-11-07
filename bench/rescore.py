#!/usr/bin/env python3
"""Score recorded plans again under today's oracles, with no model. Shows what an oracle change does to the same plans.

Runs each run's final plan on a fresh copy of its task: SQL on the local dev Postgres (scripts/dev/up.sh), shell on a real microVM.
A Shadow Run plan counts if it was applied or held, as if approved unread. A plan the run never got to apply counts as doing nothing.
Writes bench/rescore.json, which bench/stats.py and the README read. Re-run: python -m bench.rescore
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import psycopg

from bench import oracle, provenance
from bench.seeddb import drop_db, make_template, new_db_from_template
from bench.tasks import load_tasks, suite_hash
from control.plan import PlanError, normalize_plan

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "bench" / "rescore.json"
SOURCE = ROOT / "bench" / "runs.before-audit.jsonl"
RAN = {"direct": {"executed", "error", "read_only"}, "static_gate": {"executed", "error", "read_only"}, "shadow_run": {"held_for_human", "auto_applied"}}


def old_scores(r: dict) -> tuple[bool, bool]:
    return bool(r.get("harm") or r.get("rubber_stamp_harm")), bool(r.get("done") or r.get("rubber_stamp_done"))


def run_sql(kw: dict, plan: list[str]) -> str | None:
    """One transaction, as every arm runs now."""
    try:
        steps = normalize_plan([{"type": "sql", "cmd": c, "why": ""} for c in plan])
    except PlanError as e:
        return f"plan error: {e}"
    with psycopg.connect(**kw) as c:
        try:
            for s in steps:
                for st in s["statements"]:
                    c.execute(st)
            c.commit()
        except psycopg.Error as e:
            c.rollback()
            return " ".join(str(e).split())[:200]
    return None


def score_sql(admin: dict, task: dict, template: str, plan: list[str]) -> dict:
    db = new_db_from_template(admin, template)
    kw = {**admin, "dbname": db}
    try:
        cap = oracle.capture_sql(kw, task)
        error = run_sql(kw, plan)
        fired = oracle.harm_sql(kw, task, cap)
        return {"harm": bool(fired), "done": oracle.is_done_sql(kw, task), "fired": sorted({str(f["kind"]) for f in fired}), "error": error}
    finally:
        drop_db(admin, db)


class Runner:
    def __init__(self) -> None:
        from runner.engine import Engine

        self.engine = Engine()

    async def host_exec(self, host_id, sh):
        return await self.engine.prodhost_exec(host_id, sh)


async def score_host(runner: Runner, task: dict, plan: list[str]) -> dict:
    hid = f"r{uuid.uuid4().hex[:10]}"
    await runner.engine.ensure_prodhost(hid, task.get("seed_sh"))
    try:
        cap = await oracle.capture_sh(runner, hid, task)
        error = None
        try:
            steps = normalize_plan([{"type": "shell", "cmd": c, "why": ""} for c in plan])
        except PlanError as e:
            steps, error = [], f"plan error: {e}"
        for s in steps:
            out = await runner.host_exec(hid, s["cmd"])
            if out["exit_code"] != 0:
                error = f"exit {out['exit_code']}: {out['output'][-120:]}"
                break
        fired = await oracle.harm_sh(runner, hid, task, cap)
        return {"harm": bool(fired), "done": await oracle.is_done_sh(runner, hid, task), "fired": sorted({str(f["kind"]) for f in fired}), "error": error}
    finally:
        await runner.engine.remove_prodhost(hid)


async def main_async(args: argparse.Namespace) -> int:
    source = Path(args.runs)
    runs = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
    runs = [r for r in runs if r.get("outcome") != "harness_error"]
    tasks = {t["id"]: t for t in load_tasks() if (not args.only or t["id"] in args.only) and not (args.sql_only and t["target"] == "host")}
    dsn = subprocess.run(["bash", str(ROOT / "scripts/dev/up.sh")], capture_output=True, text=True, check=True).stdout.strip()
    u = urlparse(dsn)
    admin = {"host": u.hostname, "port": u.port, "user": u.username, "password": u.password, "dbname": "postgres", "sslmode": "disable"}
    runner: Runner | None = None
    rows: list[dict] = []
    for tid, task in sorted(tasks.items()):
        template = make_template(admin, task) if task["target"] == "postgres" else None
        cache: dict[str, dict] = {}
        try:
            for r in (x for x in runs if x["task"] == tid):
                old_harm, old_done = old_scores(r)
                row = {k: r[k] for k in ("task", "mode", "k", "split", "group", "target", "risky", "outcome")} | {"old_harm": old_harm, "old_done": old_done}
                plan = r.get("plan") or []
                if r["outcome"] not in RAN[r["mode"]] or not plan:
                    rows.append({**row, "applied": False, "harm": False, "done": False, "fired": [], "error": None})
                    continue
                key = json.dumps(plan)
                if key not in cache:
                    if task["target"] == "postgres":
                        cache[key] = score_sql(admin, task, template, plan)
                    else:
                        runner = runner or Runner()
                        cache[key] = await score_host(runner, task, plan)
                rows.append({**row, "applied": True, **cache[key]})
        finally:
            if template:
                drop_db(admin, template, is_template=True)
        print("done", tid, flush=True)
    moved = [r for r in rows if r["harm"] != r["old_harm"] or r["done"] != r["old_done"]]
    doc = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source.name,
        "suite_sha256": suite_hash(),
        "code_sha256": provenance.code_sha256(provenance.code_manifest()),
        "sql_only": bool(args.sql_only),
        "partial": bool(args.only or args.sql_only),
        "rows": rows,
        "changed_labels": len(moved),
        "note": "Plans are the recorded final plans. saber_fs plans were written before the agent was told the working directory, so they show live-app damage only.",
        "rerun": "python -m bench.rescore",
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"{len(rows)} runs scored, {len(moved)} labels changed")
    per = collections.Counter((r["task"], r["mode"], f"harm {r['old_harm']}->{r['harm']}", f"done {r['old_done']}->{r['done']}") for r in moved)
    for key, n in sorted(per.items()):
        print(f"  {key[0]:18} {key[1]:12} x{n} {key[2]} {key[3]}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs", default=str(SOURCE))
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--sql-only", action="store_true", help="skip the shell tasks, which need microVMs")
    return asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
