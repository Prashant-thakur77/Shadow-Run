#!/usr/bin/env python3
"""Soak test: N rehearsals through the live API, then prove nothing leaked on the runner.

Run: python scripts/soak.py --n 50. Writes bench/soak.json.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from checker.controls import TERMINAL, load_env  # noqa: E402

PLANS = [
    "DELETE FROM sessions WHERE expires_at < now() - interval '30 days'",
    "DELETE FROM users WHERE last_login_at < now() - interval '1 year'",
    "UPDATE products SET price_cents = price_cents WHERE id = 1",
    "DROP TABLE orders CASCADE",
    "SELECT pg_sleep(0.1)",
    "CREATE INDEX soak_idx ON job_logs (created_at)",
    "SELECT * FROM no_such_table",
]


async def one(c: httpx.AsyncClient, i: int) -> dict:
    r = await c.post("/api/runs", json={"steps": [{"type": "sql", "cmd": PLANS[i % len(PLANS)]}], "source": "api"})
    while r.status_code == 429:
        await asyncio.sleep(2)
        r = await c.post("/api/runs", json={"steps": [{"type": "sql", "cmd": PLANS[i % len(PLANS)]}], "source": "api"})
    r.raise_for_status()
    run_id = r.json()["id"]
    while True:
        run = (await c.get(f"/api/runs/{run_id}")).json()
        if run["status"] in TERMINAL:
            rec = (run.get("final") or {}).get("rehearsal") or {}
            return {"run": run_id, "status": run["status"], "contained": rec.get("contained"), "teardown": (rec.get("teardown") or {}).get("ok"), "ms": (rec.get("phases") or {}).get("total_ms"), "boot_ms": (rec.get("phases") or {}).get("clone_boot_ms")}
        await asyncio.sleep(1)


async def main_async(n: int, parallel: int) -> int:
    load_env()
    state = json.loads((ROOT / "infra/STATE.json").read_text())
    url = os.environ.get("SHADOWRUN_URL") or state["public_url"]
    vx1 = state["instances"]["vx1"]["main_ip"]
    ssh = ["ssh", "-i", str(ROOT / "infra/.ssh/shadowrun_ed25519"), "-o", "BatchMode=yes", f"root@{vx1}"]
    leftover_cmd = "runuser -u sbx -- bash -c 'export PATH=/opt/shadowrun/.venv/bin:$PATH; msb ls --format json' ; ls /home/sbx/.microsandbox/sandboxes 2>/dev/null | grep -c sr-run- ; pgrep -u sbx -fc sr-run- ; true"
    async with httpx.AsyncClient(base_url=url, timeout=240) as c:
        r = await c.post("/api/login", json={"username": "admin", "password": os.environ["SHADOWRUN_ADMIN_PASSWORD"]})
        r.raise_for_status()
        c.headers["Authorization"] = f"Bearer {r.json()['token']}"
        before = (await c.get("/api/prod-checksum")).json()["digest"]
        sem = asyncio.Semaphore(parallel)

        async def guarded(i: int) -> dict:
            async with sem:
                return await one(c, i)

        t0 = time.time()
        results = await asyncio.gather(*(guarded(i) for i in range(n)))
        wall = time.time() - t0
        await asyncio.sleep(3)
        after = (await c.get("/api/prod-checksum")).json()["digest"]
    leftover = subprocess.run(ssh + [leftover_cmd], capture_output=True, text=True).stdout
    rehearsed = [r for r in results if r["ms"]]
    summary = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "rehearsals": n,
        "all_contained": all(r["contained"] for r in rehearsed),
        "all_teardown_ok": all(r["teardown"] for r in rehearsed),
        "rehearsal_ms_p50": statistics.median(r["ms"] for r in rehearsed),
        "clone_boot_ms_p50": statistics.median(r["boot_ms"] for r in rehearsed),
        "wall_s": round(wall, 1),
        "statuses": {s: sum(1 for r in results if r["status"] == s) for s in {r["status"] for r in results}},
        "prod_unchanged": before == after,
        "leftover_check_raw": leftover.strip()[-300:],
        "rerun": "python scripts/soak.py --n 50",
    }
    (ROOT / "bench/soak.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0 if summary["all_contained"] and summary["all_teardown_ok"] and summary["prod_unchanged"] else 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--parallel", type=int, default=3)
    a = ap.parse_args()
    sys.exit(asyncio.run(main_async(a.n, a.parallel)))


if __name__ == "__main__":
    main()
