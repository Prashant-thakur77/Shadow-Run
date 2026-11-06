#!/usr/bin/env python3
"""Negative controls against the live system: try to break the approval and the apply, on purpose.

Every control states what must happen and records what did. Run: python -m checker.controls
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
TERMINAL = {"blocked", "applied", "rolled_back", "rejected", "drift_detected", "error", "awaiting_approval", "approved", "no_change"}
# Measured against the seeded demo: touches many rows, cascades, and passes every guardrail.
PLAN = [{"type": "sql", "cmd": "DELETE FROM sessions WHERE expires_at < now() - interval '30 days'"}]


def load_env() -> None:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v)


def login(url: str, user: str) -> httpx.Client:
    c = httpx.Client(base_url=url, timeout=240)
    r = c.post("/api/login", json={"username": user, "password": os.environ[f"SHADOWRUN_{user.upper()}_PASSWORD"]})
    r.raise_for_status()
    c.headers["Authorization"] = f"Bearer {r.json()['token']}"
    return c


def wait(c: httpx.Client, run_id: str, timeout: int = 300) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        run = c.get(f"/api/runs/{run_id}").json()
        if run["status"] in TERMINAL:
            return run
        time.sleep(1)
    raise RuntimeError(f"run {run_id} did not settle")


def new_run(c: httpx.Client) -> dict:
    r = c.post("/api/runs", json={"steps": PLAN, "source": "api"})
    r.raise_for_status()
    return wait(c, r.json()["id"])


def main() -> int:
    load_env()
    state = json.loads((ROOT / "infra/STATE.json").read_text())
    url = os.environ.get("SHADOWRUN_URL") or state["public_url"]
    judge, reviewer = login(url, "judge"), login(url, "reviewer")
    results: list[dict[str, Any]] = []

    def record(name: str, must: str, ok: bool, got: Any) -> None:
        results.append({"control": name, "must": must, "ok": bool(ok), "got": got})
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {got}", flush=True)

    judge.post("/api/demo/reset").raise_for_status()
    run = new_run(judge)
    if run["status"] != "awaiting_approval":
        print(json.dumps({k: run.get(k) for k in ("status", "error", "blocked_reason")}))
        raise SystemExit("expected the control plan to wait for approval")
    ch = run["challenge"]
    body = {k: ch[k] for k in ("plan_hash", "guardrails_hash", "report_hash", "nonce")}

    r = judge.post(f"/api/runs/{run['id']}/approve", json=body)
    record("Requester approves their own run", "403", r.status_code == 403, f"{r.status_code} {r.json().get('detail')}")

    r = reviewer.post(f"/api/runs/{run['id']}/approve", json={**body, "plan_hash": "0" * 64})
    record("Approval with a changed plan hash", "409", r.status_code == 409, f"{r.status_code} {r.json().get('detail')}")

    r = reviewer.post(f"/api/runs/{run['id']}/approve", json={**body, "report_hash": "f" * 64})
    record("Approval with a changed blast-radius report", "409", r.status_code == 409, f"{r.status_code} {r.json().get('detail')}")

    r = reviewer.post(f"/api/runs/{run['id']}/approve", json={**body, "guardrails_hash": "a" * 64})
    record("Approval with edited guardrails", "409", r.status_code == 409, f"{r.status_code} {r.json().get('detail')}")

    r = judge.post(f"/api/runs/{run['id']}/apply")
    record("Apply with no approval", "409", r.status_code == 409, f"{r.status_code} {r.json().get('detail')}")

    r = reviewer.post(f"/api/runs/{run['id']}/approve", json=body)
    record("Correct approval by a different person", "200", r.status_code == 200 and r.json()["status"] == "approved", f"{r.status_code} status={r.json().get('status')}")

    r = reviewer.post(f"/api/runs/{run['id']}/approve", json=body)
    record("Replay the same approval", "409", r.status_code == 409, f"{r.status_code} {r.json().get('detail')}")

    # Clean apply: rows on prod must match the rehearsal exactly.
    before = judge.get("/api/prod-checksum").json()
    r = judge.post(f"/api/runs/{run['id']}/apply")
    applied = r.json()
    final_counts = applied.get("apply", {}).get("actual_counts")
    record("Apply the approved plan", "committed, counts equal rehearsal", r.status_code == 200 and applied["status"] == "applied" and final_counts == applied["apply"]["expected_counts"], f"status={applied.get('status')} counts={final_counts}")
    after = judge.get("/api/prod-checksum").json()
    record("Prod really changed after apply", "digest differs", before["digest"] != after["digest"], f"{before['digest'][:12]} -> {after['digest'][:12]}")
    ev = applied.get("evidence", {})
    record("Evidence bundle written to Object Storage", "stored", ev.get("store") == "vultr-object-storage", {k: ev.get(k) for k in ("store", "key", "bytes")})
    record("Pre-apply backup written to Object Storage", "stored", applied.get("backup", {}).get("store") == "vultr-object-storage", {k: applied.get("backup", {}).get(k) for k in ("store", "key", "bytes")})

    r = judge.post(f"/api/runs/{run['id']}/apply")
    record("Apply the same run a second time", "409", r.status_code == 409, f"{r.status_code} {r.json().get('detail')}")

    # Drift: prod changes after the rehearsal. The drift check must stop it, with nothing applied.
    judge.post("/api/demo/reset").raise_for_status()
    delete_users = [{"type": "sql", "cmd": "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE last_login_at < now() - interval '2 years')"}, {"type": "sql", "cmd": "UPDATE users SET status = 'suspended' WHERE last_login_at < now() - interval '2 years'"}]
    r = judge.post("/api/runs", json={"steps": delete_users, "source": "api"})
    run = wait(judge, r.json()["id"])
    if run["status"] != "awaiting_approval":
        raise SystemExit(f"drift plan did not wait for approval: {run.get('status')} {run.get('blocked_reason')}")
    ch = run["challenge"]
    body = {k: ch[k] for k in ("plan_hash", "guardrails_hash", "report_hash", "nonce")}
    reviewer.post(f"/api/runs/{run['id']}/approve", json=body).raise_for_status()
    judge.post("/api/demo/drift").raise_for_status()
    before = judge.get("/api/prod-checksum").json()
    r = judge.post(f"/api/runs/{run['id']}/apply")
    out = r.json()
    after = judge.get("/api/prod-checksum").json()
    record("Prod changed after rehearsal; drift check on", "drift_detected, nothing applied", out.get("status") == "drift_detected" and before["digest"] == after["digest"], f"status={out.get('status')} drifted={[d['table'] for d in out.get('apply', {}).get('drifted_tables', [])]} prod unchanged={before['digest'] == after['digest']}")

    # Same drift with the first line of defence off: the count comparison must roll it back.
    judge.post("/api/demo/reset").raise_for_status()
    r = judge.post("/api/runs", json={"steps": delete_users, "source": "api"})
    run = wait(judge, r.json()["id"])
    ch = run["challenge"]
    body = {k: ch[k] for k in ("plan_hash", "guardrails_hash", "report_hash", "nonce")}
    reviewer.post(f"/api/runs/{run['id']}/approve", json=body).raise_for_status()
    judge.post("/api/demo/drift").raise_for_status()
    before = judge.get("/api/prod-checksum").json()
    r = judge.post(f"/api/runs/{run['id']}/apply", json={"drift_check": False})
    out = r.json()
    after = judge.get("/api/prod-checksum").json()
    record("Prod changed after rehearsal; drift check off", "rolled_back on count mismatch, nothing applied", out.get("status") == "rolled_back" and before["digest"] == after["digest"] and bool(out.get("apply", {}).get("count_mismatches")), f"status={out.get('status')} reason={out.get('apply', {}).get('reason')} mismatches={out.get('apply', {}).get('count_mismatches')} prod unchanged={before['digest'] == after['digest']}")

    # Blocked plans cannot be approved past their guardrail.
    judge.post("/api/demo/reset").raise_for_status()
    r = judge.post("/api/runs", json={"steps": [{"type": "sql", "cmd": "DELETE FROM users WHERE last_login_at < now() - interval '1 year'"}], "source": "api"})
    run = wait(judge, r.json()["id"])
    record("Cascade trap via the API: guardrail stops it", "blocked", run["status"] == "blocked", f"status={run['status']} failed={[g['name'] for g in (run.get('final') or {}).get('guardrails', []) if not g['passed']]}")
    r = reviewer.post(f"/api/runs/{run['id']}/approve", json={"plan_hash": run.get("plan_hash") or "", "guardrails_hash": run.get("guardrails_hash") or "", "report_hash": "x", "nonce": "x"})
    record("Approve a blocked plan anyway", "409", r.status_code == 409, f"{r.status_code} {r.json().get('detail')}")

    r = judge.post("/api/runs", json={"steps": [{"type": "sql", "cmd": "COMMIT; DROP TABLE orders CASCADE"}], "source": "api"})
    run = wait(judge, r.json()["id"])
    record("Plan tries to end its own transaction", "blocked by gate", run["status"] == "blocked" and run["attempts"][-1]["verdict"] == "blocked_by_gate", f"status={run['status']} verdict={run['attempts'][-1].get('verdict')}")

    # Attacks on the measurement itself. These came out of an independent adversarial review of this code.
    def submit(sql: list[str]) -> dict:
        judge.post("/api/demo/reset").raise_for_status()
        r = judge.post("/api/runs", json={"steps": [{"type": "sql", "cmd": c} for c in sql], "source": "api"})
        r.raise_for_status()
        return wait(judge, r.json()["id"])

    before = None
    judge.post("/api/demo/reset").raise_for_status()
    before = judge.get("/api/prod-checksum").json()["digest"]
    run = submit(["UPDATE users SET email = CASE WHEN current_user = 'agent' THEN email ELSE 'pwned' || id || '@evil.test' END WHERE id <= 5"])
    after = judge.get("/api/prod-checksum").json()["digest"]
    record(
        "Plan that only misbehaves on prod (branches on current_user), counts identical", "rolled back on row content, prod unchanged",
        run["status"] == "rolled_back" and bool(run.get("apply", {}).get("content_mismatches")) and before == after,
        f"status={run['status']} reason={run.get('apply', {}).get('reason')} prod unchanged={before == after}",
    )

    run = submit(["ALTER TABLE users ALTER COLUMN email TYPE text USING 'wiped' || id"])
    final = run.get("final") or {}
    flagged = bool((final.get("report") or {}).get("unlogged_changes"))
    record(
        "Column rewrite that fires no row trigger and moves no statistic", "not auto-applied, flagged as unmeasured",
        run["status"] == "awaiting_approval" and flagged, f"status={run['status']} flagged={flagged}",
    )

    run = submit(["WITH d AS (DELETE FROM job_logs WHERE id <= 50 RETURNING id) UPDATE feature_flags SET note = 'x' WHERE key = 'sso'"])
    record("DELETE hidden in a CTE, under budget", "needs a person", run["status"] == "awaiting_approval", f"status={run['status']}")

    run = submit(["CREATE FUNCTION d() RETURNS void LANGUAGE plpgsql AS $x$ BEGIN DELETE FROM job_logs WHERE id <= 50; END $x$", "SELECT d()"])
    totals = ((run.get("final") or {}).get("report") or {}).get("totals", {})
    record("DELETE hidden in a function body, under budget", "needs a person, rows still measured", run["status"] == "awaiting_approval" and totals.get("rows_deleted") == 50, f"status={run['status']} rows_deleted={totals.get('rows_deleted')}")

    run = submit([
        "UPDATE invoices SET amount_cents = 0 WHERE id IN (SELECT id FROM invoices WHERE status = 'paid' ORDER BY id LIMIT 3)",
        "UPDATE pg_temp.before_invoices b SET amount_cents = 0 WHERE id IN (SELECT id FROM pg_temp.before_invoices WHERE status = 'paid' ORDER BY id LIMIT 3)",
    ])
    record("Plan rewrites the guardrail baseline to hide its damage", "blocked", run["status"] == "blocked", f"status={run['status']} verdict={run['attempts'][-1].get('verdict')}")

    run = submit([
        "CREATE FUNCTION bomb() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN DELETE FROM audit_log; RETURN NULL; END $x$",
        "CREATE CONSTRAINT TRIGGER bomb AFTER UPDATE ON feature_flags DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bomb()",
        "UPDATE feature_flags SET note = 'x' WHERE key = 'sso'",
    ])
    tables = {t["table"]: t for t in ((run.get("final") or {}).get("report") or {}).get("tables", [])}
    record(
        "Deferred trigger that fires at COMMIT, after the checks", "its damage is measured, and it needs a person",
        run["status"] == "awaiting_approval" and (tables.get("audit_log") or {}).get("deleted", 0) > 0,
        f"status={run['status']} audit_log deleted={(tables.get('audit_log') or {}).get('deleted')}",
    )

    chain = judge.get("/api/audit?limit=1").json()["chain"]
    record("Audit log hash chain verifies", "ok", chain.get("ok") is True, chain)

    judge.post("/api/demo/reset").raise_for_status()
    out = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "url": url, "passed": sum(r["ok"] for r in results), "total": len(results), "controls": results}
    path = ROOT / "bench" / "controls.json"
    path.write_text(json.dumps(out, indent=2) + "\n")
    print(f"{out['passed']}/{out['total']} controls passed; wrote {path.relative_to(ROOT)}")
    return 0 if out["passed"] == out["total"] else 1


if __name__ == "__main__":
    sys.exit(main())
