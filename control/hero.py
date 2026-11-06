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
