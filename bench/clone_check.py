#!/usr/bin/env python3
"""Does every database in the suite restore into a clone that matches it? No model involved.

A clone missing a foreign key reports a smaller blast radius than the real database, so this checks what the benchmark's
numbers stand on: each task's database goes through the same snapshot and restore, and the runner compares rows and schema.
Run on the control VM. Writes bench/clone_check.json. Re-run: bash scripts/bench_remote.sh 'python -m bench.clone_check'
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

from bench.run import load_config, make_template
from bench.seeddb import drop_db
from bench.tasks import load_tasks
from control.runner_client import RunnerClient, RunnerError
from control.snapshot import ProdConn, expected_clone, take_snapshot

OUT = Path(__file__).resolve().parent / "clone_check.json"


async def check(admin: dict, runner: RunnerClient, task: dict) -> dict:
    template = await asyncio.to_thread(make_template, admin, task)
    try:
        conn = ProdConn(admin["host"], str(admin["port"]), admin["user"], admin["password"], template, admin.get("sslmode", "require"))
        snap = await asyncio.to_thread(take_snapshot, conn)
        try:
            # Drop any golden built before this check existed, so this restore really runs it.
            await runner.drop_snapshot(snap["snapshot_id"])
            info = await runner.put_snapshot(snap["snapshot_id"], snap["dump_path"], expected_clone(snap))
            return {"task": task["id"], "matches": bool((info.get("timing") or {}).get("matches_prod")), "tables": len(snap["tables"])}
        except RunnerError as e:
            return {"task": task["id"], "matches": False, "error": str(e)[:400]}
        finally:
            Path(snap["dump_path"]).unlink(missing_ok=True)
    finally:
        await asyncio.to_thread(drop_db, admin, template, True)


async def main_async() -> int:
    admin, *_ = load_config()
    runner = RunnerClient()
    rows = []
    for task in load_tasks():
        if task["target"] == "host":
            continue
        row = await check(admin, runner, task)
        rows.append(row)
        print(json.dumps(row), flush=True)
    doc = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "databases": len(rows), "matched": sum(1 for r in rows if r["matches"]),
        "rows": rows, "rerun": "bash scripts/bench_remote.sh 'python -m bench.clone_check'",
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    print(doc["matched"], "of", doc["databases"], "clones match")
    return 0 if doc["matched"] == doc["databases"] else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main_async()))
