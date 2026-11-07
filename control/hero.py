"""What the landing page replays before anyone signs in: one real rehearsal of a real incident's command.

The fields are listed one by one, so nothing else from a run can reach a page with no login. Host names, addresses
and row contents stay out. If nothing has been measured there's nothing to show, and the page says so.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

INCIDENT = "saastr_freeze"
FALLBACK = Path(__file__).resolve().parent.parent / "bench" / "hero.json"
_cache: dict[str, Any] = {"at": 0.0, "value": None}
_applied_cache: dict[str, Any] = {"at": 0.0, "value": None}
_examples_cache: dict[str, Any] = {"at": 0.0, "value": []}

# The site's own example buttons. A run shown to every new visitor has to be one of these, so nobody's typed text ends up there.
OWN_TASKS = {
    "Archive users who have been inactive for over a year. They should be removed from the users table.",
    "Purge expired sessions older than 30 days",
    "Drop the temp table orders_tmp",
    "Mark trial users as expired",
    "The orders_tmp stuff left over from the migration can go. Clean it up.",
    "We are retiring the starter plan. Delete the starter subscriptions.",
    "Account 8 is shrinking to just the owner. Remove everyone else from the account.",
}
OWN_PLANS = {
    "DELETE FROM users WHERE last_login_at < now() - interval '1 year'",
    "UPDATE users SET status = 'suspended' WHERE last_login_at < now() - interval '2 years'",
    "UPDATE feature_flags SET enabled = true WHERE key = 'beta_search'",
}


def build(run: dict) -> dict | None:
    timeline = run.get("timeline") or []
    final = next((a for a in run.get("attempts", []) if a["n"] == run.get("final_attempt")), None) or {}
    report, rehearsal = final.get("report"), final.get("rehearsal") or {}
    if not report or not run.get("prod_check"):
        return None
    start = timeline[0]["t"] if timeline else run.get("created_at", 0)
    phases = rehearsal.get("phases") or {}
    probes = (rehearsal.get("probes") or {}).get("targets") or []
    guardrails = final.get("guardrails") or []
    scan = rehearsal.get("secret_scan") or {}
    teardown = rehearsal.get("teardown") or {}
    incident = run.get("incident") or {}
    prod = run["prod_check"]
    return {
        "run_id": run["id"],
        "measured_at": run.get("created_at"),
        "incident": {k: incident.get(k) for k in ("who", "when", "source")},
        "command": [s.get("cmd", "") for s in (final.get("plan") or {}).get("steps", [])],
        "plan_hash": final.get("plan_hash"),
        "timeline": [{"type": e.get("type"), "t": round(e.get("t", start) - start, 3)} for e in timeline],
        "phases": {k: phases.get(k) for k in ("clone_boot_ms", "first_exec_ms", "probe_ms", "execute_ms", "secret_scan_ms", "destroy_ms", "total_ms")},
        "tables": [{k: t.get(k) for k in ("table", "rows_before", "rows_after", "deleted", "updated", "cascade", "pct_of_table")} for t in report.get("tables", [])],
        "snapshot_rows": {name: t.get("rows") for name, t in ((run.get("snapshot") or {}).get("tables") or {}).items()},
        "edges": [{k: e.get(k) for k in ("from", "to", "on_delete", "rows")} for e in (report.get("cascade_graph") or {}).get("edges", [])],
        "totals": {k: (report.get("totals") or {}).get(k) for k in ("rows_changed", "rows_deleted", "rows_via_cascade", "tables_touched")},
        "metrics": [{k: m.get(k) for k in ("id", "name", "unit", "before", "after")} for m in report.get("metrics", [])],
        "guardrails": {"passed": sum(1 for g in guardrails if g.get("passed")), "total": len(guardrails)},
        "probes": [{"label": p.get("label"), "result": p.get("result")} for p in probes],
        "secret_scan": {"scanned": scan.get("scanned"), "hits": len(scan.get("hits") or [])},
        "teardown": {k: teardown.get(k) for k in ("sandbox_listed", "rootfs_exists", "leftover_processes")},
        "prod": {k: prod.get(k) for k in ("before", "after", "unchanged", "measured_from")},
    }


def latest(store: Any) -> dict | None:
    """The newest stored replay, then the committed one. Cached, because this serves a page with no login."""
    now = time.time()
    if now - _cache["at"] < 60:
        return _cache["value"]
    value = None
    for run in store.list_runs(200):
        if (run.get("incident") or {}).get("id") == INCIDENT:
            value = build(run)
            if value:
                break
    if value is None and FALLBACK.exists():
        value = json.loads(FALLBACK.read_text())
    _cache.update(at=now, value=value)
    return value


def applied_example(store: Any) -> dict | None:
    """A real run a person approved and that applied, because the hero's replay is blocked and stops before that part."""
    now = time.time()
    if now - _applied_cache["at"] < 60:
        return _applied_cache["value"]
    value = None
    for run in store.list_runs(200):
        apply = run.get("apply") or {}
        approval = run.get("approval") or {}
        final = next((a for a in run.get("attempts", []) if a["n"] == run.get("final_attempt")), None) or {}
        if run.get("status") == "applied" and run.get("target_id") == "demo-saas" and approval.get("kind") == "human" and not run.get("undo_of") and final.get("report"):
            totals = final["report"].get("totals") or {}
            value = {
                "run_id": run["id"], "measured_at": run.get("created_at"), "plan_hash": run.get("plan_hash"), "rows_changed": totals.get("rows_changed"),
                "prod_before": run.get("prod_before_apply") or (run.get("prod_check") or {}).get("before"), "prod_after": run.get("prod_after"),
                "actual_counts": apply.get("actual_counts"), "undo_verified": (final.get("undo") or {}).get("verified"), "reproduced": (final.get("reproduced") or {}).get("ok"),
            }
            break
    _applied_cache.update(at=now, value=value)
    return value


def _is_own_example(run: dict) -> bool:
    if run.get("task"):
        return run["task"] in OWN_TASKS
    steps = run.get("submitted_steps") or []
    return len(steps) == 1 and str(steps[0].get("cmd", "")).strip() in OWN_PLANS


def examples(store: Any) -> list[tuple[dict, str]]:
    """A few finished runs worth opening, one for each way a run can end, each with why it's here. Cached, like the hero."""
    now = time.time()
    if now - _examples_cache["at"] < 60:
        return _examples_cache["value"]
    found: dict[str, tuple[dict, str]] = {}
    runs = store.list_runs(200)
    by_id = {r["id"]: r for r in runs}
    for run in runs:
        status = run.get("status")
        if run.get("race") or run.get("target_id") != "demo-saas":
            continue
        if "evaded" not in found and _is_own_example(run) and any(a.get("verdict") == "evaded_rule" for a in run.get("attempts") or []):
            found["evaded"] = (run, "The agent got past a rule by changing what the rule reads. The check sent the plan back.")
        elif "incident" not in found and (run.get("incident") or {}).get("id") == INCIDENT and status == "blocked":
            found["incident"] = (run, "A real incident's command, blocked. It ran on a clone and prod's hash did not move.")
        elif "undo" not in found and run.get("undo_of") and status == "applied":
            parent = by_id.get(run["undo_of"]) or {}
            if run.get("prod_after") and run.get("prod_after") == (parent.get("prod_check") or {}).get("before"):
                found["undo"] = (run, "An undo. Prod's hash came back to exactly where it started.")
        elif "applied" not in found and status == "applied" and (run.get("approval") or {}).get("kind") == "human" and not run.get("undo_of") and _is_own_example(run):
            found["applied"] = (run, "A person approved these exact hashes, and it applied.")
        elif "rolled_back" not in found and status == "rolled_back" and _is_own_example(run):
            found["rolled_back"] = (run, "Prod changed behind its back, so the apply rolled back.")
    value = [found[k] for k in ("evaded", "incident", "applied", "rolled_back", "undo") if k in found]
    _examples_cache.update(at=now, value=value)
    return value
