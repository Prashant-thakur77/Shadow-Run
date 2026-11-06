#!/usr/bin/env python3
"""Drive a real run through the public API and print what happened. Needs .env for the demo logins."""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
for line in (ROOT / ".env").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1)
        os.environ.setdefault(k, v)
STATE = json.loads((ROOT / "infra/STATE.json").read_text())
URL = os.environ.get("SHADOWRUN_URL") or STATE["public_url"]
TERMINAL = {"blocked", "applied", "rolled_back", "rejected", "drift_detected", "error", "awaiting_approval", "approved", "no_change"}


def client(user: str) -> httpx.Client:
    c = httpx.Client(base_url=URL, timeout=180)
    pw = os.environ[f"SHADOWRUN_{user.upper()}_PASSWORD"]
    r = c.post("/api/login", json={"username": user, "password": pw})
    r.raise_for_status()
    c.headers["Authorization"] = f"Bearer {r.json()['token']}"
    return c


def wait(c: httpx.Client, run_id: str, timeout: int = 400) -> dict:
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        run = c.get(f"/api/runs/{run_id}").json()
        if run["status"] != last:
            print(f"  [{time.time() - t0:6.1f}s] {run['status']}", flush=True)
            last = run["status"]
        if run["status"] in TERMINAL:
            return run
        time.sleep(1.5)
    raise SystemExit("timed out")


def show(run: dict) -> None:
    for a in run["attempts"]:
        print(f"--- attempt {a['n']}: {a.get('verdict')}  plan_hash={str(a.get('plan_hash'))[:12]}")
        for s in (a.get("plan") or {}).get("steps", []):
            print("    PLAN:", " ".join(s["cmd"].split())[:170])
        for s in (a.get("report") or {}).get("sentences", [])[:8]:
            print("    MEASURED:", s["text"])
        for g in a.get("guardrails", []):
            print(f"    GUARDRAIL {'pass' if g['passed'] else 'FAIL'}: {g['name']}" + (f" ({g.get('error')})" if g.get("error") else ""))
        if a.get("error"):
            print("    ERROR:", str(a["error"])[:300])
        if a.get("explanation", {}).get("text"):
            print("    EXPLAIN:", a["explanation"]["text"][:400], "| numbers verified:", a["explanation"].get("numbers_verified"))
        rec = a.get("rehearsal") or {}
        if rec:
            print("    RECORD: guest", rec.get("guest"), "host kernel", rec.get("host", {}).get("kernel"), "nics", rec.get("probes", {}).get("nics"), "contained", rec.get("contained"), "teardown", rec.get("teardown", {}).get("ok"), "scan", rec.get("secret_scan", {}).get("ok"))
            print("    PHASES:", rec.get("phases"))
    print("status:", run["status"], "| cost $%.5f" % run.get("cost_usd", 0), "| blocked:", run.get("blocked_reason"))
    print("data flags:", [(f.get("table"), f.get("verdict")) for f in run.get("data_flags", [])])
    print("usage:", [(u["phase"], u["model"], u["prompt_tokens"], u["completion_tokens"], round(u["seconds"], 1)) for u in run.get("usage", [])])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("task", nargs="?", default="Delete users who have been inactive for over a year to keep the users table clean.")
    ap.add_argument("--sql")
    ap.add_argument("--sh")
    ap.add_argument("--target", default="demo-saas")
    args = ap.parse_args()
    c = client("judge")
    body = {"task": None, "steps": [{"type": "sql", "cmd": args.sql}]} if args.sql else {"task": args.task}
    if args.sh:
        body = {"steps": [{"type": "shell", "cmd": args.sh}]}
    body["target_id"] = args.target
    run_id = c.post("/api/runs", json=body).json()["id"]
    print("run", run_id)
    show(wait(c, run_id))


if __name__ == "__main__":
    main()
