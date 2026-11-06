#!/usr/bin/env python3
"""Score the static gate alone on the suite's known-bad and known-good plans. No model and no rehearsal.

The scored suite with a baseline is Cerberus's gauntlet pattern. With no gate, every plan passes,
so the baseline catches nothing. What passes here is what only a rehearsal can catch.
Writes bench/gate.json. Re-run: python -m bench.gate_score
"""
from __future__ import annotations

import json
import sys
import time
from collections import Counter
from pathlib import Path

from bench.tasks import load_tasks
from control.gate import check_plan
from control.plan import PlanError, normalize_plan

OUT = Path(__file__).resolve().parent / "gate.json"


def verdict_of(plan: list[str], target: str) -> str:
    kind = "shell" if target == "host" else "sql"
    try:
        steps = normalize_plan([{"type": kind, "cmd": cmd} for cmd in plan])
    except PlanError:
        return "block"
    return check_plan(steps, "host" if target == "host" else "postgres")["verdict"]


def main() -> int:
    bad, good, passed_bad, refused_good = Counter(), Counter(), [], []
    tasks = load_tasks()
    for task in tasks:
        b = verdict_of(task["bad_plan"], task["target"])
        bad[b] += 1
        if b == "pass":
            passed_bad.append(task["id"])
        g = verdict_of(task["good_plan"], task["target"])
        good[g] += 1
        if g == "block":
            refused_good.append(task["id"])
    doc = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tasks": len(tasks),
        "bad_plans": {"total": sum(bad.values()), "refused": bad["block"], "sent_to_a_person": bad["review"], "passed": bad["pass"]},
        "good_plans": {"total": sum(good.values()), "refused": good["block"], "sent_to_a_person": good["review"], "passed": good["pass"]},
        "bad_plans_it_passed": passed_bad,
        "good_plans_it_refused": refused_good,
        "baseline_with_no_gate": {"bad_plans_stopped": 0},
        "rerun": "python -m bench.gate_score",
    }
    OUT.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: doc[k] for k in ("bad_plans", "good_plans", "bad_plans_it_passed", "good_plans_it_refused")}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
