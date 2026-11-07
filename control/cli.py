#!/usr/bin/env python3
"""`shadowrun`: the same engine from a terminal or a CI pipeline.

Exit codes: 0 passed and applied or nothing to do; 2 waiting for a person; 3 blocked; 4 rolled back or drifted; 1 error.
Environment: SHADOWRUN_URL, SHADOWRUN_TOKEN (get one with `shadowrun login --guest` on the open demo, `shadowrun login NAME`, or from the web app).
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


class CliError(Exception):
    """Something a person can act on. main() prints it as one line and exits 1."""


def client() -> httpx.Client:
    url = os.environ.get("SHADOWRUN_URL", "http://localhost:8100")
    token = os.environ.get("SHADOWRUN_TOKEN", "")
    return httpx.Client(base_url=url, timeout=240, headers={"Authorization": f"Bearer {token}"} if token else {})


def answer(response: httpx.Response) -> dict:
    """The JSON of a good reply, or the server's own reason for refusing."""
    if response.is_success:
        return response.json()
    try:
        detail = response.json().get("detail")
    except (ValueError, AttributeError):
        detail = None
    if isinstance(detail, list):
        detail = "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detail)
    if response.status_code == 401:
        raise CliError("not signed in. Set SHADOWRUN_TOKEN, for example: export SHADOWRUN_TOKEN=$(shadowrun login --guest)")
    raise CliError(f"{response.status_code} from the server: {detail or response.reason_phrase}")


def read_password() -> str:
    if sys.stdin.isatty():
        return getpass.getpass("password: ")
    # A pipe still works. With nothing piped in there is no one to ask, so this ends rather than warning about echo.
    line = sys.stdin.readline().rstrip("\n")
    if not line:
        raise EOFError
    return line


def read_plan(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    try:
        return Path(path).read_text()
    except OSError as e:
        raise CliError(f"can't read {path}: {e.strerror or e}") from e


def wait(c: httpx.Client, run_id: str) -> dict:
    last = None
    while True:
        run = answer(c.get(f"/api/runs/{run_id}"))
        if run["status"] != last:
            print(f"  {run['status']}", file=sys.stderr)
            last = run["status"]
        if run["status"] in TERMINAL:
            return run
        time.sleep(1)


def metric_value(metric: dict, value: float | None) -> str:
    if value is None:
        return "n/a"
    prefix = "$" if metric.get("unit") in ("usd", "dollars", "$") else ""
    return f"{prefix}{value:,.0f}"


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


def markdown(run: dict) -> str:
    """A pull request comment: what this migration really does, measured on a clone of prod."""
    final = run.get("final") or {}
    report = final.get("report") or {}
    icon = {"applied": "Applied", "awaiting_approval": "Needs a person", "blocked": "Blocked", "no_change": "No change", "rolled_back": "Rolled back", "drift_detected": "Prod drifted"}.get(run["status"], run["status"])
    url = os.environ.get("SHADOWRUN_URL", "").rstrip("/")
    lines = [f"### Shadow Run: {icon}", "", f"Rehearsed on a disposable clone of prod in a microVM. [Full report]({url}/runs/{run['id']}), plan `{str(run.get('plan_hash'))[:12]}`.", ""]
    if run.get("rehearse_only") and run.get("status") != "applied":
        lines += ["This was a rehearsal only. Nothing reached prod.", ""]
    if run.get("blocked_reason"):
        lines += [f"**{run['blocked_reason']}**", ""]
    sentences = report.get("sentences", [])
    if sentences:
        lines += ["| Measured by Postgres |", "| --- |"] + [f"| {s['text']} |" for s in sentences[:12]] + [""]
    moved = [m for m in report.get("metrics", []) if m.get("before") != m.get("after")]
    if moved:
        lines += ["| Business metric | Before | After |", "| --- | ---: | ---: |"] + [f"| {m['name']} | {metric_value(m, m['before'])} | {metric_value(m, m['after'])} |" for m in moved] + [""]
    failed = [g for g in final.get("guardrails", []) if not g.get("passed")]
    guardrails = final.get("guardrails", [])
    if guardrails:
        lines += [f"Guardrails: {len(guardrails) - len(failed)} of {len(guardrails)} passed."] + [f"- Failed: {g['name']}" for g in failed] + [""]
    findings = (final.get("gate") or {}).get("findings", [])
    if findings:
        lines += ["Static gate:"] + [f"- `{f['rule']}`: {f['reason']}" for f in findings[:8]] + [""]
    opinion = final.get("second_opinion") or {}
    if opinion.get("verdict") in ("partly", "does_not"):
        said = " ".join(x for x in (opinion.get("left_out"), opinion.get("added")) if x)
        lines += [f"A second model ({opinion.get('model')}) doubts this does what was asked: {said}", ""]
    undo = final.get("undo") or {}
    if undo.get("verified"):
        lines += ["Undo plan generated and proved on the clone.", ""]
    return "\n".join(lines)


def dispatch(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="shadowrun", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    login = sub.add_parser("login", help="print a token for SHADOWRUN_TOKEN")
    login.add_argument("username", nargs="?", help="an account with a password. On the open demo, use --guest instead")
    login.add_argument("--guest", action="store_true", help="the open demo's guest, no password")
    r = sub.add_parser("rehearse", help="rehearse a plan file on a clone")
    r.add_argument("plan", help=".sql or .sh file, or - for stdin")
    r.add_argument("--target", default="demo-saas")
    r.add_argument("--json", action="store_true")
    r.add_argument("--markdown", action="store_true", help="print a pull request comment")
    r.add_argument("--rehearse-only", action="store_true", help="never apply by itself, even inside the auto-apply list. Use this in CI.")
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
    args = ap.parse_args(argv)
    c = client()

    def steps_from(path: str) -> list[dict]:
        text = read_plan(path)
        kind = "shell" if path.endswith(".sh") else "sql"
        return [{"type": kind, "cmd": text}]

    if args.cmd == "login":
        if args.guest:
            print(answer(c.post("/api/demo/enter"))["token"])
            return 0
        if not args.username:
            raise CliError("say who: shadowrun login NAME, or shadowrun login --guest on the open demo")
        try:
            pw = read_password()
        except (EOFError, OSError) as e:
            raise CliError("a password needs a terminal. On the open demo, use: shadowrun login --guest") from e
        print(answer(c.post("/api/login", json={"username": args.username, "password": pw}))["token"])
        return 0
    if args.cmd == "check":
        out = answer(c.post("/api/check", json={"target_id": args.target, "steps": steps_from(args.plan)}))
        print(json.dumps(out, indent=2))
        return {"pass": 0, "review": 2, "block": 3}[out["gate"]["verdict"]]
    if args.cmd in ("rehearse", "task"):
        body = {"target_id": args.target, "source": "cli"}
        body.update({"steps": steps_from(args.plan), "rehearse_only": args.rehearse_only} if args.cmd == "rehearse" else {"task": args.text})
        run_id = answer(c.post("/api/runs", json=body))["id"]
        run = wait(c, run_id)
        if getattr(args, "json", False):
            print(json.dumps(run, indent=1))
        elif getattr(args, "markdown", False):
            print(markdown(run))
        else:
            summary(run)
        return EXIT.get(run["status"], 1)
    if args.cmd == "status":
        run = answer(c.get(f"/api/runs/{args.run_id}"))
        summary(run)
        return EXIT.get(run["status"], 0)
    if args.cmd == "apply":
        run = answer(c.post(f"/api/runs/{args.run_id}/apply"))
        summary(run)
        return EXIT.get(run["status"], 1)
    return 1


def main(argv: list[str] | None = None) -> int:
    """Every failure a person can meet here is one line, with no traceback."""
    url = os.environ.get("SHADOWRUN_URL", "http://localhost:8100")
    try:
        return dispatch(argv)
    except CliError as e:
        print(f"shadowrun: {e}", file=sys.stderr)
    except httpx.TransportError as e:
        print(f"shadowrun: can't reach {url}: {e or type(e).__name__}. Set SHADOWRUN_URL to the server's address.", file=sys.stderr)
    except httpx.InvalidURL as e:
        print(f"shadowrun: SHADOWRUN_URL isn't a usable address: {e}", file=sys.stderr)
    except KeyboardInterrupt:
        print("shadowrun: stopped", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
