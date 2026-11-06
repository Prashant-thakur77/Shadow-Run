#!/usr/bin/env python3
"""Replay the real incidents through the live system. Writes bench/incidents.json."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from checker.controls import load_env, login, wait  # noqa: E402


def main() -> int:
    load_env()
    url = os.environ.get("SHADOWRUN_URL") or json.loads((ROOT / "infra/STATE.json").read_text())["public_url"]
    judge = login(url, "judge")
    judge.post("/api/demo/reset").raise_for_status()
    judge.post("/api/demo/reset?target_id=demo-host").raise_for_status()
    out = []
    for inc in judge.get("/api/incidents").json():
        run = wait(judge, judge.post(f"/api/incidents/{inc['id']}/replay").json()["id"])
        final = run.get("final") or {}
        report = final.get("report") or {}
        measured = [s["text"] for s in report.get("sentences", [])][:6]
        metrics = [{"name": m["name"], "unit": m["unit"], "before": m["before"], "after": m["after"]} for m in report.get("metrics", []) if m.get("before") != m.get("after")]
        rec = final.get("rehearsal") or {}
        row = {
            "id": inc["id"], "who": inc["who"], "when": inc["when"], "source": inc["source"], "command": inc["command"].strip(), "adapted": inc.get("adapted"),
            "status": run["status"], "verdict": final.get("verdict"), "gate": (final.get("gate") or {}).get("verdict"), "gate_rules": sorted({f["rule"] for f in (final.get("gate") or {}).get("findings", [])}),
            "measured": measured, "metrics": metrics, "failed_guardrails": [g["name"] for g in final.get("guardrails", []) if not g.get("passed")],
            "reached_prod": run["status"] == "applied", "contained": rec.get("contained"), "prod_unchanged": (run.get("prod_check") or {}).get("unchanged"), "run": run["id"],
            "blocked_reason": run.get("blocked_reason"),
        }
        out.append(row)
        print(f"{row['who'][:34]:34} {row['status']:18} gate={row['gate']:7} reached prod={row['reached_prod']} prod unchanged={row['prod_unchanged']}", flush=True)
        for m in measured[:3]:
            print("     ", m[:110], flush=True)
    doc = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "url": url, "incidents": out, "rerun": "python scripts/incidents_live.py"}
    (ROOT / "bench/incidents.json").write_text(json.dumps(doc, indent=1) + "\n")
    judge.post("/api/demo/reset").raise_for_status()
    judge.post("/api/demo/reset?target_id=demo-host").raise_for_status()
    return 0 if not any(r["reached_prod"] for r in out) else 1


if __name__ == "__main__":
    sys.exit(main())
