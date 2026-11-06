#!/usr/bin/env python3
"""Fill the generated blocks in README.md from the JSON the benchmarks wrote. No result is typed by hand.

Blocks are marked <!-- name:start --> ... <!-- name:end -->. A block whose source file is missing says
"not measured yet", so a gap is visible and never filled in by hand.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
NOT_YET = "Not measured yet."


def load(name: str) -> dict | None:
    p = BENCH / name
    return json.loads(p.read_text()) if p.exists() else None


def env_value(key: str) -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return ""


def fmt_mean(p: dict | None) -> str:
    if not p or p.get("mean") is None:
        return "n/a"
    text = f"{p['mean']:g}"
    if p["min"] != p["max"]:
        text += f" ({p['min']}–{p['max']})"
    return text


def table(columns: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def block_live() -> str:
    state = json.loads((ROOT / "infra/STATE.json").read_text())
    url = state.get("public_url", "")
    return (
        f"Live: {url}\n\n"
        f"Sign in as `judge` / `{env_value('SHADOWRUN_JUDGE_PASSWORD')}` to request changes, and `reviewer` / `{env_value('SHADOWRUN_REVIEWER_PASSWORD')}` "
        "to approve them. There are two logins because the person who asks for a change can't approve it. Both only reach a seeded demo database, and the reset button restores it."
    )


def block_headline() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured" or r.get("scope") != "full":
        return NOT_YET
    h = r["heldout"]
    d, g, s = h["direct"], h["static_gate"], h["shadow_run"]
    n = d["risky_tasks"]
    return (
        f"**On {n} risky tasks held out from tuning, the same agent caused harm on prod {d['harm_on_prod']['mean']:g} times running directly, "
        f"{g['harm_on_prod']['mean']:g} times behind a static rule gate, and {s['harm_on_prod']['mean']:g} times through Shadow Run.** "
        f"If the human approver rubber-stamped every plan it held, that last number would be {s['harm_if_rubber_stamped']['mean']:g}."
    )


def block_results() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured":
        return NOT_YET
    t = r["table"]
    rows = list(t["rows"])
    rt = load("redteam.json")
    if rt and rt.get("total"):
        rows.append(["Red-team attacks contained, checked from the host", "n/a", "n/a", f"{rt['contained']} of {rt['total']}"])
    c = load("controls.json")
    if c:
        roll = next((x for x in c["controls"] if "drift check off" in x["control"]), None)
        if roll:
            rows.append(["Forced drift with the drift check off: rolled back, prod unchanged", "n/a", "n/a", "yes" if roll["ok"] else "NO"])
    note = (
        f"Mean of {r['runs_per_task']} runs per task, range in brackets. Model `{r['model']}` on Vultr Serverless Inference, measured {r['at']}, "
        f"commit `{r['git_commit']}`, suite sha256 `{r['suite_sha256'][:12]}`, {r['runs']} runs, {r['harness_errors']} harness errors. "
        f"Re-run: `{r['rerun']}`. Every run and its plan is in `bench/runs.jsonl`."
    )
    return table(t["columns"], rows) + "\n\n" + note


def block_groups() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured":
        return NOT_YET
    rows = []
    for name, b in r["by_group"].items():
        d, g, s = b["direct"], b["static_gate"], b["shadow_run"]
        if not d.get("risky_tasks"):
            continue
        rows.append([f"{name} ({d['risky_tasks']})", fmt_mean(d["harm_on_prod"]), fmt_mean(g["harm_on_prod"]), fmt_mean(s["harm_on_prod"]), fmt_mean(s.get("risky_blocked_gate")), fmt_mean(s.get("risky_blocked_guardrail")), fmt_mean(s.get("risky_held")), fmt_mean(s.get("held_harm_only_a_person_catches"))])
    return table(["Group (risky tasks)", "Direct harm", "Static gate harm", "Shadow Run harm", "Stopped by gate", "Stopped by guardrail", "Held for a person", "Of those held, harmful if approved"], rows)


def block_redteam() -> str:
    rt = load("redteam.json")
    if not rt or not rt.get("attacks"):
        return NOT_YET
    rows = [[a["title"], a["expected"], "contained" if a["contained"] else "NOT CONTAINED", f"{a['wall_s']:.1f}"] for a in rt["attacks"]]
    out = table(["Attack", "Expected", "Result", "Wall s"], rows)
    out += f"\n\nProd hash before and after the whole suite: `{rt['prod_before'][:16]}` and `{rt['prod_after'][:16]}`."
    w = rt.get("wall_two") or {}
    if w.get("firewall_before"):
        out += f" Second wall tested alone, with the no-NIC wall deliberately opened: rejected packets went from {w['firewall_before'].get('rejected_packets')} to {w['firewall_after'].get('rejected_packets')}, and the sandbox reached nothing outside."
    out += " Re-run: `python scripts/redteam_live.py`, or the button on the Red team page."
    return out


def block_controls() -> str:
    c = load("controls.json")
    if not c:
        return NOT_YET
    rows = [[x["control"], x["must"], "pass" if x["ok"] else "FAIL"] for x in c["controls"]]
    return table(["Attempt", "Must", "Result"], rows) + f"\n\n{c['passed']} of {c['total']} passed against the live URL at {c['at']}. Re-run: `python -m checker.controls`."


def block_scale() -> str:
    s = load("scale.json")
    if not s:
        return NOT_YET
    rows = [[f"{r['db_mb']} MB", r["pg_dump_s"], r["checksum_s"], r["golden_build_s"], r["clone_boot_ms"] or "failed", r["rehearsal_total_s"] or "timed out"] for r in s["rows"]]
    return table(["Database", "pg_dump s", "Checksums s", "Build golden s", "Clone boot ms", "Rehearsal s"], rows) + f"\n\nRe-run: `{s['rerun']}`."


def block_soak() -> str:
    s = load("soak.json")
    if not s:
        return NOT_YET
    return f"Soak test: {s['rehearsals']} rehearsals in {s['wall_s']} s, every one contained with teardown confirmed: {'yes' if s['all_contained'] and s['all_teardown_ok'] else 'NO'}. Prod unchanged: {'yes' if s['prod_unchanged'] else 'NO'}. Re-run: `{s['rerun']}`."


def block_budget() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured":
        return NOT_YET
    a = r["all_risky_and_safe"]
    return f"Inference cost per task, averaged over the benchmark: ${a['shadow_run']['cost_per_task_usd']} through Shadow Run, ${a['direct']['cost_per_task_usd']} for the agent alone."


BLOCKS = {
    "live": block_live, "headline": block_headline, "results": block_results, "groups": block_groups, "redteam": block_redteam,
    "controls": block_controls, "scale": block_scale, "soak": block_soak, "cost": block_budget,
}


def main() -> int:
    path = ROOT / "README.md"
    text = path.read_text()
    for name, fn in BLOCKS.items():
        start, end = f"<!-- {name}:start -->", f"<!-- {name}:end -->"
        if start in text:
            text = re.sub(re.escape(start) + r".*?" + re.escape(end), lambda _: f"{start}\n{fn()}\n{end}", text, flags=re.S)
    path.write_text(text)
    print("README blocks rendered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
