#!/usr/bin/env python3
"""Replay every plan the benchmark recorded through today's static gate, and compare with the verdict recorded at the time.

The benchmark ran with an earlier shell parser. This shows whether its numbers still describe this code.
Writes bench/gate_replay.json. No VM, database or model needed.
"""
from __future__ import annotations

import glob
import json
from pathlib import Path

from control import gate
from control.plan import PlanError, normalize_plan

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    compared = same = 0
    changed = []
    for path in sorted(glob.glob(str(ROOT / "bench" / "runs*.jsonl"))):
        for line in open(path):
            run = json.loads(line)
            recorded = (run.get("gate") or {}).get("verdict") or run.get("gate_verdict")
            if not recorded or not run.get("plan"):
                continue
            try:
                steps = normalize_plan([{"cmd": c} for c in run["plan"]] if run["target"] != "host" else [{"type": "shell", "cmd": c} for c in run["plan"]])
            except PlanError:
                continue
            now = gate.check_plan(steps, "shell" if run["target"] == "host" else "postgres")
            compared += 1
            same += now["verdict"] == recorded
            if now["verdict"] != recorded:
                changed.append({"task": run["task"], "mode": run["mode"], "run": run["k"], "file": Path(path).name, "recorded": recorded, "now": now["verdict"], "still_stopped": now["flagged"], "rules": sorted({f["rule"] for f in now["findings"]})})
    doc = {"plans": compared, "same_verdict": same, "changed": changed}
    (ROOT / "bench" / "gate_replay.json").write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: v for k, v in doc.items() if k != "changed"}))
    for c in changed:
        print(c)


if __name__ == "__main__":
    main()
