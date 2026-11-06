#!/usr/bin/env python3
"""The honest negative: rehearsal cost grows with database size. Measures each stage at several sizes.

Run on the control VM with the benchmark env: python -m bench.scale --scales 1 5 50. Writes bench/scale.json.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from pathlib import Path

import psycopg

from bench.run import load_config
from control.runner_client import RunnerClient, RunnerError
from control.snapshot import ProdConn, expected_clone, take_snapshot
from demo.seed import seed

ROOT = Path(__file__).resolve().parent.parent
TRAP = "DELETE FROM users WHERE last_login_at < now() - interval '1 year'"


async def measure(admin: dict, runner: RunnerClient, scale: float) -> dict:
    name = f"bs_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(**admin, autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    kw = {**admin, "dbname": name}
    try:
        t0 = time.perf_counter()
        with psycopg.connect(**kw) as c:
            seed(c, scale=scale)
        seed_s = round(time.perf_counter() - t0, 1)
        with psycopg.connect(**kw) as c:
            size = c.execute("SELECT pg_database_size(current_database())").fetchone()[0]
            users = c.execute("SELECT count(*) FROM users").fetchone()[0]
        conn = ProdConn(admin["host"], str(admin["port"]), admin["user"], admin["password"], name, admin.get("sslmode", "require"))
        snap = await asyncio.to_thread(take_snapshot, conn)
        t0 = time.perf_counter()
        try:
            loaded = await runner.put_snapshot(snap["snapshot_id"], snap["dump_path"], expected_clone(snap))
        except RunnerError as e:
            # A clone that doesn't match prod is refused, and that's a result to publish, not a crash.
            return {"scale": scale, "db_mb": round(size / 1e6), "users": users, "seed_s": seed_s, "dump_mb": round(snap["bytes"] / 1e6, 1), "refused": str(e)[:600], "rehearsals_ok": 0, "rehearsal_total_s": None, "clone_boot_ms": None, "checksum_s": round(snap["timing"]["checksum_ms"] / 1000, 2), "pg_dump_s": round(snap["timing"]["pg_dump_ms"] / 1000, 2), "golden_build_s": None}
        finally:
            Path(snap["dump_path"]).unlink(missing_ok=True)
        golden_s = round(time.perf_counter() - t0, 2)
        rehearsals = []
        for _ in range(3):
            rec = await runner.rehearse(f"sc{uuid.uuid4().hex[:10]}", snap["snapshot_id"], [{"statements": [TRAP]}], [], max_duration=280)
            rehearsals.append(rec)
        ok = [r for r in rehearsals if not r.get("sandbox_error") and (r.get("result") or {}).get("ok")]
        best = sorted(ok, key=lambda r: r["phases"]["total_ms"])
        mid = best[len(best) // 2] if best else {}
        return {
            "scale": scale,
            "db_mb": round(size / 1e6),
            "users": users,
            "seed_s": seed_s,
            "dump_mb": round(snap["bytes"] / 1e6, 1),
            "checksum_s": round(snap["timing"]["checksum_ms"] / 1000, 2),
            "pg_dump_s": round(snap["timing"]["pg_dump_ms"] / 1000, 2),
            "golden_build_s": golden_s,
            "restore_in_vm_s": round((loaded.get("timing") or {}).get("restore_ms", 0) / 1000, 2),
            "golden_cached": bool(loaded.get("cached")),
            "clone_boot_ms": (mid.get("phases") or {}).get("clone_boot_ms"),
            "rehearsal_total_s": round(mid["phases"]["total_ms"] / 1000, 2) if mid else None,
            "rehearsal_each_s": [round(r["phases"]["total_ms"] / 1000, 2) for r in best],
            "execute_s": round(mid["phases"]["execute_ms"] / 1000, 2) if mid else None,
            # A time means little without what was done in it, and the same plan can touch a different share of a bigger seed.
            "rows_changed": sum(c["rows"] for c in (mid.get("result") or {}).get("changes", [])) if mid else None,
            "rehearsals_ok": len(ok),
            "errors": [str(r.get("sandbox_error") or (r.get("result") or {}).get("error"))[:200] for r in rehearsals if r not in ok][:2],
        }
    finally:
        with psycopg.connect(**admin, autocommit=True) as c:
            c.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


async def main_async(scales: list[float]) -> int:
    admin, *_ = load_config()
    runner = RunnerClient()
    rows = []
    for s in scales:
        row = await measure(admin, runner, s)
        rows.append(row)
        print(json.dumps(row), flush=True)
    out = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "rows": rows, "rerun": "python -m bench.scale --scales " + " ".join(str(s) for s in scales)}
    (ROOT / "bench/scale.json").write_text(json.dumps(out, indent=2) + "\n")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--scales", nargs="+", type=float, default=[1, 8, 90])
    raise SystemExit(asyncio.run(main_async(ap.parse_args().scales)))


if __name__ == "__main__":
    main()
