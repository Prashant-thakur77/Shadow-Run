#!/usr/bin/env python3
"""Run the full red team on the live VX1 through the public API and write bench/redteam.json."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from checker.controls import ROOT, load_env, login  # noqa: E402
import os  # noqa: E402


def main() -> int:
    load_env()
    state = json.loads((ROOT / "infra/STATE.json").read_text())
    url = os.environ.get("SHADOWRUN_URL") or state["public_url"]
    judge = login(url, "judge")
    doc = judge.post("/api/redteam").json()
    t0 = time.time()
    seen = 0
    while doc.get("status") == "running" and time.time() - t0 < 300:
        time.sleep(2)
        doc = next(d for d in judge.get("/api/redteam?limit=5").json() if d["id"] == doc["id"])
        for a in doc["attacks"][seen:]:
            print(f"{'CONTAINED' if a['contained'] else 'NOT CONTAINED':14} {a['attack']:18} {a['wall_s']:6.1f}s ended={a.get('ended')} firewall={a.get('firewall')}", flush=True)
            for c in a["checks"]:
                if not c["ok"]:
                    print("    FAILED:", c["check"], c.get("detail", ""), flush=True)
        seen = len(doc["attacks"])
    print(json.dumps({k: doc.get(k) for k in ("status", "contained", "total", "prod_unchanged", "prod_before", "prod_after", "error")}, indent=1))
    print("wall two:", json.dumps(doc.get("wall_two"))[:900])
    doc["url"] = url
    (ROOT / "bench" / "redteam.json").write_text(json.dumps(doc, indent=2) + "\n")
    wall_two_held = (doc.get("wall_two") or {}).get("contained") is True
    return 0 if doc.get("contained") == doc.get("total") and doc.get("prod_unchanged") and doc.get("golden_unchanged") and wall_two_held else 1


if __name__ == "__main__":
    sys.exit(main())
