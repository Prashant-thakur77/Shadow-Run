#!/usr/bin/env python3
"""Paired, task-level statistics for the benchmark. Standard library only: no database, model or network.

Reads bench/runs.jsonl and, when they're present, bench/runs.controls.jsonl, bench/runs.restrict.jsonl and bench/rescore.json, then
writes bench/stats.json, which the README's numbers come from. Re-run: python -m bench.stats

Why the task is the unit: the three runs of a task share a prompt, a schema and a low temperature, so they're close to copies of
one observation. 23 tasks at 3 runs is about 23 observations, not 69. So every interval here resamples tasks, a second, wider one
also resamples the runs inside each task, and p values are exact two-sided paired permutation tests over tasks.

Outcomes follow bench/run.py:
    every arm           harm = harm                                        done safely = done and not harm
    Shadow Run, unread  harm = harm or rubber_stamp_harm                   done safely = (done or rubber_stamp_done) and not harm
"""
from __future__ import annotations

import argparse
import collections
import itertools
import json
import math
import random
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parent
OUT = BENCH / "stats.json"
SEED = 20261107
METRICS = ("harm", "done")
CASCADE_LIKE = {"cascade", "soft_delete"}
SOURCE_MODE = {"unread": "shadow_run", "as_run": "shadow_run"}


def load_runs(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return [r for r in rows if r.get("outcome") != "harness_error"]


def load_json(path: Path) -> dict | None:
    return json.loads(path.read_text()) if path.exists() else None


def score(r: dict, arm: str) -> dict[str, int]:
    if arm == "unread":
        harm = bool(r.get("harm") or r.get("rubber_stamp_harm"))
        done = bool(r.get("done") or r.get("rubber_stamp_done"))
    else:
        harm, done = bool(r.get("harm")), bool(r.get("done"))
    return {"harm": int(harm), "done": int(done and not harm)}


def by_task(runs: list[dict], arm: str, metric: str) -> dict[str, list[int]]:
    """{task: its score on each run}, in run order. arm is a mode, or unread or as_run for Shadow Run."""
    out: dict[str, list[int]] = collections.defaultdict(list)
    mode = SOURCE_MODE.get(arm, arm)
    for r in sorted((r for r in runs if r["mode"] == mode), key=lambda r: (r["task"], r["k"])):
        out[r["task"]].append(score(r, arm)[metric])
    return dict(out)


def mean(xs) -> float:
    xs = list(xs)
    return sum(xs) / len(xs) if xs else float("nan")


def quantile(sorted_xs: list[float], q: float) -> float:
    pos = q * (len(sorted_xs) - 1)
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_xs[lo] + (sorted_xs[hi] - sorted_xs[lo]) * (pos - lo)


def sign_test_p(wins: int, losses: int) -> float:
    n = wins + losses
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(min(wins, losses) + 1)) / 2**n
    return min(1.0, 2 * tail)


def permutation_p(diffs: list[float], rng: random.Random, draws: int = 100_000) -> float:
    """Two-sided, on the sum of paired differences. Exact up to 20 tasks that moved, Monte Carlo above that."""
    moved = [d for d in diffs if d]
    if not moved:
        return 1.0
    observed = abs(sum(moved)) - 1e-12
    if len(moved) <= 20:
        hits = sum(1 for signs in itertools.product((1, -1), repeat=len(moved)) if abs(sum(s * d for s, d in zip(signs, moved))) >= observed)
        return hits / 2 ** len(moved)
    hits = sum(1 for _ in range(draws) if abs(sum(d if rng.random() < 0.5 else -d for d in moved)) >= observed)
    return (hits + 1) / (draws + 1)


def compare(a: dict[str, list[int]], b: dict[str, list[int]], tasks: list[str], label: str, boots: int) -> dict:
    """b minus a, by task. Every comparison has its own seeded generator, so adding one doesn't move the others."""
    rng = random.Random(f"{SEED}|{label}")
    tasks = [t for t in tasks if a.get(t) and b.get(t)]
    n = len(tasks)
    ma, mb = [mean(a[t]) for t in tasks], [mean(b[t]) for t in tasks]
    diffs = [y - x for x, y in zip(ma, mb)]
    total_a, total_b = sum(ma), sum(mb)
    one_stage, two_stage = [], []
    varying_a = [len(set(a[t])) > 1 for t in tasks]
    varying_b = [len(set(b[t])) > 1 for t in tasks]
    for _ in range(boots if n else 0):
        sample = [rng.randrange(n) for _ in range(n)]
        one_stage.append(sum(diffs[i] for i in sample))
        two = 0.0
        for i in sample:
            t = tasks[i]
            two += (mean(rng.choice(b[t]) for _ in b[t]) if varying_b[i] else mb[i]) - (mean(rng.choice(a[t]) for _ in a[t]) if varying_a[i] else ma[i])
        two_stage.append(two)
    one_stage.sort()
    two_stage.sort()
    up = sum(1 for d in diffs if d > 0)
    down = sum(1 for d in diffs if d < 0)
    ci = [round(quantile(one_stage, 0.025), 2), round(quantile(one_stage, 0.975), 2)] if n else [0.0, 0.0]
    return {
        "tasks": n,
        "from": round(total_a, 2),
        "to": round(total_b, 2),
        "difference": round(total_b - total_a, 2),
        "ci95": ci,
        "ci95_also_resampling_runs": [round(quantile(two_stage, 0.025), 2), round(quantile(two_stage, 0.975), 2)] if n else [0.0, 0.0],
        "excludes_zero": ci[0] > 0 or ci[1] < 0,
        "tasks_up": up,
        "tasks_down": down,
        "tasks_same": n - up - down,
        "sign_p": round(sign_test_p(up, down), 4),
        "permutation_p": round(permutation_p(diffs, rng), 4),
        "up": sorted((t, round(d, 2)) for t, d in zip(tasks, diffs) if d > 0),
        "down": sorted((t, round(d, 2)) for t, d in zip(tasks, diffs) if d < 0),
    }


def totals(runs: list[dict], arm: str, tasks: list[str]) -> dict:
    out = {}
    for metric in METRICS:
        scores = by_task(runs, arm, metric)
        out[metric] = round(sum(mean(scores[t]) for t in tasks if scores.get(t)), 2)
    out["tasks"] = sum(1 for t in tasks if by_task(runs, arm, "harm").get(t))
    return out


def comparisons(pairs: list[tuple[str, list[dict], str, list[dict], str]], tasks: list[str], scope: str, boots: int) -> dict:
    """pairs are (name, runs_a, arm_a, runs_b, arm_b), and each is compared as b minus a on both metrics."""
    out = {}
    for name, runs_a, arm_a, runs_b, arm_b in pairs:
        out[name] = {metric: compare(by_task(runs_a, arm_a, metric), by_task(runs_b, arm_b, metric), tasks, f"{scope}|{name}|{metric}", boots) for metric in METRICS}
    return out


def guardrail_coverage(runs: list[dict], tasks: list[str], attempts: list[dict] | None = None) -> dict:
    """Of the tasks where direct did harm: did a guardrail ever fail for Shadow Run's agent, and what was left?"""
    direct, unread = by_task(runs, "direct", "harm"), by_task(runs, "unread", "harm")
    fired = {r["task"] for r in (attempts or runs) if r["mode"] == "shadow_run" and "failed_guardrails" in (r.get("verdicts") or [])}
    harmed = [t for t in tasks if mean(direct.get(t, [0])) > 0]

    def row(chosen: list[str]) -> dict:
        return {"tasks": len(chosen), "direct_harm": round(sum(mean(direct[t]) for t in chosen), 2), "unread_harm": round(sum(mean(unread.get(t, [0])) for t in chosen), 2), "ids": chosen}

    return {"covered": row([t for t in harmed if t in fired]), "not_covered": row([t for t in harmed if t not in fired])}


def retry_facts(runs: list[dict]) -> dict:
    held = [r for r in runs if r["mode"] == "shadow_run" and r["risky"] and r["split"] == "heldout"]
    rewrote = [r for r in held if "failed_guardrails" in (r.get("verdicts") or [])]
    applied = [r for r in runs if r["mode"] == "shadow_run" and r["outcome"] == "auto_applied"]
    return {
        "heldout_runs": len(held),
        "rewrote_after_a_failed_guardrail": len(rewrote),
        "rewrote_tasks": len({r["task"] for r in rewrote}),
        "rewrote_by_group": dict(collections.Counter(r["group"] for r in rewrote)),
        "tries_above_one": sum(1 for r in held if r.get("tries", 1) > 1),
        "direct_tries_above_one": sum(1 for r in runs if r["mode"] == "direct" and r["risky"] and r["split"] == "heldout" and r.get("tries", 1) > 1),
        "auto_applied_runs": len(applied),
        "auto_applied_that_changed_something": sum(1 for r in applied if any((r.get("report_totals") or {}).values())),
        "approved_plans_rolled_back": sum(1 for r in runs if r.get("rubber_stamp_apply") not in (None, "committed")),
    }


def task_sets(runs: list[dict]) -> dict[str, list[str]]:
    meta = {r["task"]: r for r in runs}
    risky = sorted(t for t, r in meta.items() if r["risky"])
    heldout = [t for t in risky if meta[t]["split"] == "heldout"]
    return {
        "heldout": heldout,
        "external": [t for t in risky if meta[t]["split"] == "external"],
        "saber_db": [t for t in risky if meta[t]["group"] == "saber_db"],
        "saber_fs": [t for t in risky if meta[t]["group"] == "saber_fs"],
        "tuning": [t for t in risky if meta[t]["split"] == "tuning"],
        "heldout_without_cascade_and_soft_delete": [t for t in heldout if meta[t]["group"] not in CASCADE_LIKE],
        "heldout_and_external": [t for t in risky if meta[t]["split"] in ("heldout", "external")],
    }


def analyse_main(runs: list[dict], boots: int, doc: dict | None) -> dict:
    meta = {r["task"]: r for r in runs}
    sets = task_sets(runs)
    out: dict = {"suite_sha256": (doc or {}).get("suite_sha256"), "code_sha256": (doc or {}).get("code_sha256"), "at": (doc or {}).get("at"), "clean_runs": len(runs), "sets": {}}
    arms = [a for a in ("direct", "static_gate", "unread", "as_run") if any(r["mode"] == SOURCE_MODE.get(a, a) for r in runs)]
    pairs = [
        ("unread_vs_direct", runs, "direct", runs, "unread"),
        ("unread_vs_gate", runs, "static_gate", runs, "unread"),
        ("gate_vs_direct", runs, "direct", runs, "static_gate"),
    ]
    pairs = [p for p in pairs if p[2] in arms and p[4] in arms]
    for name, tasks in sets.items():
        if not tasks:
            continue
        out["sets"][name] = {"tasks": len(tasks), "ids": tasks, "arms": {a: totals(runs, a, tasks) for a in arms}, "compare": comparisons(pairs, tasks, f"main|{name}", boots)}
    loo: dict = {}
    for name in ("heldout", "external"):
        loo[name] = {}
        for group in sorted({meta[t]["group"] for t in sets[name]}):
            tasks = [t for t in sets[name] if meta[t]["group"] != group]
            if tasks:
                loo[name][group] = {"tasks": len(tasks), **comparisons(pairs[:1], tasks, f"loo|{name}|{group}", max(1000, boots // 4))["unread_vs_direct"]}
    out["leave_one_group_out"] = loo
    out["by_group"] = {g: {"tasks": len(ts), "arms": {a: totals(runs, a, ts) for a in arms}} for g in sorted({meta[t]["group"] for t in meta if meta[t]["risky"]}) for ts in [[t for t in sets["heldout_and_external"] + sets["tuning"] if meta[t]["group"] == g]]}
    out["retries"] = retry_facts(runs)
    out["guardrail_coverage"] = {name: guardrail_coverage(runs, sets[name]) for name in ("heldout", "external") if sets[name]}
    return out


def analyse_controls(main: list[dict], controls: list[dict], boots: int, main_doc: dict | None, doc: dict | None) -> dict:
    """The control arms against direct and against Shadow Run approved unread, on the tasks the control run covered."""
    meta = {r["task"]: r for r in controls}
    risky = sorted(t for t, r in meta.items() if r["risky"])
    sets = {
        "heldout_sql": [t for t in risky if meta[t]["split"] == "heldout"],
        "saber_db": [t for t in risky if meta[t]["group"] == "saber_db"],
    }
    safe = sorted(t for t, r in meta.items() if not r["risky"])
    pairs = [
        ("rules_vs_direct", main, "direct", controls, "rules_in_prompt"),
        ("rollback_vs_direct", main, "direct", controls, "rollback"),
        ("unread_vs_direct", main, "direct", main, "unread"),
        ("unread_vs_rules", controls, "rules_in_prompt", main, "unread"),
        ("unread_vs_rollback", controls, "rollback", main, "unread"),
    ]

    def arms_on(tasks: list[str]) -> dict:
        return {"direct": totals(main, "direct", tasks), "rules_in_prompt": totals(controls, "rules_in_prompt", tasks), "rollback": totals(controls, "rollback", tasks), "unread": totals(main, "unread", tasks)}

    out: dict = {
        "same_code_as_main": bool(main_doc and doc and main_doc.get("code_sha256") and main_doc.get("code_sha256") == doc.get("code_sha256")),
        "same_suite_as_main": bool(main_doc and doc and main_doc.get("suite_sha256") == doc.get("suite_sha256")),
        "status": (doc or {}).get("status"),
        "at": (doc or {}).get("at"),
        "sets": {},
        "safe": {"tasks": len(safe), "arms": arms_on(safe)} if safe else None,
    }
    for name, tasks in sets.items():
        if tasks:
            out["sets"][name] = {"tasks": len(tasks), "ids": tasks, "arms": arms_on(tasks), "compare": comparisons(pairs, tasks, f"controls|{name}", boots)}
    return out


def analyse_restrict(main: list[dict], restrict: list[dict], boots: int, main_doc: dict | None, doc: dict | None) -> dict:
    """The same task subset with ON DELETE RESTRICT on the money tables, and on the cascading schema for comparison."""
    meta = {r["task"]: r for r in restrict}
    tasks = sorted(t for t, r in meta.items() if r["risky"])
    return {
        "same_code_as_main": bool(main_doc and doc and main_doc.get("code_sha256") and main_doc.get("code_sha256") == doc.get("code_sha256")),
        "same_suite_as_main": bool(main_doc and doc and main_doc.get("suite_sha256") == doc.get("suite_sha256")),
        "status": (doc or {}).get("status"),
        "at": (doc or {}).get("at"),
        "tasks": len(tasks),
        "ids": tasks,
        "arms": {"direct": totals(restrict, "direct", tasks), "unread": totals(restrict, "unread", tasks)},
        "cascading_schema": {"direct": totals(main, "direct", tasks), "unread": totals(main, "unread", tasks)},
        "compare": comparisons([("unread_vs_direct", restrict, "direct", restrict, "unread"), ("direct_vs_cascading", main, "direct", restrict, "direct"), ("unread_vs_cascading", main, "unread", restrict, "unread")], tasks, "restrict", boots),
    }


def analyse_rescore(doc: dict, before: list[dict], boots: int) -> dict:
    """The same recorded plans, under the oracles they ran with and under today's. A row's harm and done already include the approval."""
    now = doc["rows"]
    sets = task_sets(now)
    pairs = [("unread_vs_direct", now, "direct", now, "shadow_run"), ("gate_vs_direct", now, "direct", now, "static_gate")]
    out: dict = {"at": doc.get("at"), "source": doc.get("source"), "suite_sha256": doc.get("suite_sha256"), "partial": doc.get("partial"), "changed_labels": doc.get("changed_labels"), "sets": {}}
    out["guardrail_coverage"] = {name: guardrail_coverage(now, sets[name], before) for name in ("heldout", "external") if sets.get(name)}
    for name, tasks in sets.items():
        if tasks:
            out["sets"][name] = {
                "tasks": len(tasks),
                "before": {a: totals(before, a, tasks) for a in ("direct", "static_gate", "unread")},
                "after": {"direct": totals(now, "direct", tasks), "static_gate": totals(now, "static_gate", tasks), "unread": totals(now, "shadow_run", tasks)},
                "compare": comparisons(pairs, tasks, f"rescore|{name}", boots),
            }
    return out


def build(boots: int = 10000) -> dict:
    main_runs = load_runs(BENCH / "runs.jsonl")
    main_doc = load_json(BENCH / "results.json")
    doc: dict = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": SEED, "boots": boots, "unit": "task", "rerun": "python -m bench.stats"}
    doc["main"] = analyse_main(main_runs, boots, main_doc) if main_runs else None
    before = load_runs(BENCH / "runs.before-audit.jsonl")
    before_doc = load_json(BENCH / "results.before-audit.json")
    doc["before_audit"] = analyse_main(before, max(1000, boots // 4), before_doc) if before else None
    rescore = load_json(BENCH / "rescore.json")
    doc["rescored"] = analyse_rescore(rescore, before, max(1000, boots // 2)) if rescore and before else None
    controls = load_runs(BENCH / "runs.controls.jsonl")
    doc["controls"] = analyse_controls(main_runs, controls, boots, main_doc, load_json(BENCH / "results.controls.json")) if controls and main_runs else None
    restrict = load_runs(BENCH / "runs.restrict.jsonl")
    doc["restrict"] = analyse_restrict(main_runs, restrict, boots, main_doc, load_json(BENCH / "results.restrict.json")) if restrict and main_runs else None
    return doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--boots", type=int, default=10000)
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    doc = build(args.boots)
    Path(args.out).write_text(json.dumps(doc, indent=1) + "\n")
    held = (doc["main"] or {}).get("sets", {}).get("heldout")
    if held:
        for metric in METRICS:
            c = held["compare"]["unread_vs_direct"][metric]
            print(f"held-out {metric}: {c['from']} -> {c['to']}, difference {c['difference']:+g}, 95% CI {c['ci95']}, {c['tasks_up']} up, {c['tasks_down']} down, p = {c['permutation_p']}")
    print(f"controls: {'yes' if doc['controls'] else 'not run'}; restrict: {'yes' if doc['restrict'] else 'not run'}; rescored: {'yes' if doc['rescored'] else 'not run'}")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
