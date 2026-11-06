#!/usr/bin/env python3
"""`shadowrun`: the same engine from a terminal or a CI pipeline.

Exit codes: 0 passed and applied or nothing to do; 2 waiting for a person; 3 blocked; 4 rolled back or drifted; 1 error.
Environment: SHADOWRUN_URL, SHADOWRUN_TOKEN (get one with `shadowrun login`, or from the web app).
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import time
from pathlib import Path

import httpx

TERMINAL = {"blocked", "applied", "rolled_back", "rejected", "drift_detected", "error", "awaiting_approval", "approved", "no_change"}
EXIT = {"applied": 0, "no_change": 0, "approved": 2, "awaiting_approval": 2, "blocked": 3, "rejected": 3, "rolled_back": 4, "drift_detected": 4, "error": 1}


def client() -> httpx.Client:
    url = os.environ.get("SHADOWRUN_URL", "http://localhost:8100")
    token = os.environ.get("SHADOWRUN_TOKEN", "")
    return httpx.Client(base_url=url, timeout=240, headers={"Authorization": f"Bearer {token}"} if token else {})


def wait(c: httpx.Client, run_id: str) -> dict:
    last = None
    while True:
        run = c.get(f"/api/runs/{run_id}").raise_for_status().json()
        if run["status"] != last:
            print(f"  {run['status']}", file=sys.stderr)
            last = run["status"]
        if run["status"] in TERMINAL:
            return run
        time.sleep(1)


def summary(run: dict) -> None:
    final = run.get("final") or {}
    print(f"run       {run['id']}")
    print(f"status    {run['status']}")
    print(f"plan      {run.get('plan_hash')}")
    if run.get("blocked_reason"):
        print(f"blocked   {run['blocked_reason']}")
    for f in (final.get("gate") or {}).get("findings", []):
        print(f"gate      [{f['severity']}] {f['rule']}: {f['reason']}")
    for s in (final.get("report") or {}).get("sentences", []):
        print(f"measured  {s['text']}")
    for g in final.get("guardrails", []):
        print(f"guardrail {'pass' if g['passed'] else 'FAIL'}  {g['name']}")
    if run.get("apply"):
        print(f"apply     {run['apply'].get('outcome')}: {run['apply'].get('reason')}")


def main() -> int:
    ap = argparse.ArgumentParser(prog="shadowrun", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    login = sub.add_parser("login", help="print a token for SHADOWRUN_TOKEN")
    login.add_argument("username")
    r = sub.add_parser("rehearse", help="rehearse a plan file on a clone")
    r.add_argument("plan", help=".sql or .sh file, or - for stdin")
    r.add_argument("--target", default="demo-saas")
    r.add_argument("--json", action="store_true")
    t = sub.add_parser("task", help="give the built-in agent a task in plain English")
    t.add_argument("text")
    t.add_argument("--target", default="demo-saas")
    s = sub.add_parser("status", help="show a run")
    s.add_argument("run_id")
    a = sub.add_parser("apply", help="apply an approved run")
    a.add_argument("run_id")
    ck = sub.add_parser("check", help="static gate only, no rehearsal")
    ck.add_argument("plan")
    ck.add_argument("--target", default="demo-saas")
    args = ap.parse_args()
    c = client()

    def steps_from(path: str) -> list[dict]:
        text = sys.stdin.read() if path == "-" else Path(path).read_text()
        kind = "shell" if path.endswith(".sh") else "sql"
        return [{"type": kind, "cmd": text}]

    if args.cmd == "login":
        pw = getpass.getpass("password: ")
        print(c.post("/api/login", json={"username": args.username, "password": pw}).raise_for_status().json()["token"])
        return 0
    if args.cmd == "check":
        out = c.post("/api/check", json={"target_id": args.target, "steps": steps_from(args.plan)}).raise_for_status().json()
        print(json.dumps(out, indent=2))
        return {"pass": 0, "review": 2, "block": 3}[out["gate"]["verdict"]]
    if args.cmd in ("rehearse", "task"):
        body = {"target_id": args.target, "source": "cli"}
        body.update({"steps": steps_from(args.plan)} if args.cmd == "rehearse" else {"task": args.text})
        run_id = c.post("/api/runs", json=body).raise_for_status().json()["id"]
        run = wait(c, run_id)
        if getattr(args, "json", False):
            print(json.dumps(run, indent=1))
        else:
            summary(run)
        return EXIT.get(run["status"], 1)
    if args.cmd == "status":
        run = c.get(f"/api/runs/{args.run_id}").raise_for_status().json()
        summary(run)
        return EXIT.get(run["status"], 0)
    if args.cmd == "apply":
        run = c.post(f"/api/runs/{args.run_id}/apply").raise_for_status().json()
        summary(run)
        return EXIT.get(run["status"], 1)
    return 1


if __name__ == "__main__":
    sys.exit(main())
