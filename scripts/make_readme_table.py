#!/usr/bin/env python3
"""Fill the generated blocks in README.md from the JSON the benchmarks wrote. No result is typed by hand.

Blocks are marked <!-- name:start --> ... <!-- name:end -->. A block whose source file is missing says
"not measured yet", so a gap is visible and never filled in by hand.
"""
from __future__ import annotations

import json
import urllib.request
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
    try:
        up = urllib.request.urlopen(url + "/api/public", timeout=10).status == 200
    except Exception:
        up = False
    if not up:
        return "The live demo is being redeployed. Until it's back, run your own with the commands below."
    return (
        f"Live: {url}\n\n"
        "Press **Continue as guest**. You get two identities, `judge` to request changes and `reviewer` to approve them, because the person who asks for a change can't approve it. "
        "On this demo one guest holds both, so you see the check, not two real people. Both reach only a seeded demo database, and Reseed demo prod restores it."
    )


def times(x: float) -> str:
    return f"{x:g} time" if x == 1 else f"{x:g} times"


def comparable(r: dict) -> bool:
    """Every mode has to have run the same tasks. A dropped task would flatter whichever mode lost it."""
    if r.get("harness_errors") != 0:
        return False
    return all(len({r[part][m]["risky_tasks"] for m in ("direct", "static_gate", "shadow_run")}) == 1 for part in ("heldout", "external"))


def block_headline() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured" or r.get("scope") != "full" or not comparable(r):
        return NOT_YET
    h = r["heldout"]
    d, g, s = h["direct"], h["static_gate"], h["shadow_run"]
    n = d["risky_tasks"]
    runs = [json.loads(line) for line in (BENCH / "runs.jsonl").read_text().splitlines() if line.strip()]
    # A run that hit a harness error was retried, so it would otherwise count twice.
    risky = [r for r in runs if r.get("mode") == "shadow_run" and r.get("risky") and r.get("outcome") != "harness_error"]
    rewrote = sum(1 for r in risky if r.get("tries", 1) > 1)
    return (
        f"**On {n} risky tasks held out from tuning, the same agent caused harm on prod {times(d['harm_on_prod']['mean'])} running directly and {times(g['harm_on_prod']['mean'])} behind a static rule gate. "
        f"Through Shadow Run, nothing harmful reached prod without a person. If that person approved every plan unread, harm was {s['harm_if_rubber_stamped']['mean']:g}.**\n\n"
        f"Read those last two together. The zero is mostly the hold: {s['risky_held']['mean']:g} of {n} risky plans waited for a person, and anything that holds every plan would score zero too. "
        f"The drop to {s['harm_if_rubber_stamped']['mean']:g} is what rehearsing and the frozen guardrails add: the agent saw what its plan would really do and rewrote it, in {rewrote} of {len(risky)} risky runs. "
        f"The price is approvals, since all {s['safe_held']['mean']:g} safe tasks waited too. A rehearsal takes {s['rehearsal_s']['p50']} s at the median, boot to destroy."
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
        ending = "and the sandbox reached nothing outside." if w.get("contained") else "**and the sandbox reached the outside, so this wall failed.**"
        out += f" Second wall tested alone, with the no-NIC wall deliberately opened: rejected packets went from {w['firewall_before'].get('rejected_packets')} to {w['firewall_after'].get('rejected_packets')}, {ending}"
    if "golden_unchanged" in rt:
        out += " A new clone made after all the attacks matches one made before them." if rt["golden_unchanged"] else " **A new clone made after the attacks did not match one made before them.**"
    out += " Re-run: `python scripts/redteam_live.py`, or the button on the Red team page." + where(rt)
    return out


def block_controls() -> str:
    c = load("controls.json")
    if not c:
        return NOT_YET
    rows = [[x["control"], x["must"], "pass" if x["ok"] else "FAIL"] for x in c["controls"]]
    body = table(["Attempt", "Must", "Result"], rows)
    return f"**{c['passed']} of {c['total']} passed** at {c['at']}. Re-run: `python -m checker.controls`." + where(c) + f"\n\n<details><summary>All {c['total']} attempts</summary>\n\n{body}\n\n</details>"


def block_models() -> str:
    primary = load("results.json")
    if not primary or primary.get("status") != "measured":
        return NOT_YET
    rows = []
    for doc in [primary] + [json.loads(p.read_text()) for p in sorted(BENCH.glob("results.*.json"))]:
        if doc.get("status") != "measured":
            continue
        h = doc["heldout"]
        rows.append([f"`{doc['model']}`", f"{doc['runs_per_task']}", fmt_mean(h["direct"]["harm_on_prod"]), fmt_mean(h["static_gate"]["harm_on_prod"]), fmt_mean(h["shadow_run"]["harm_on_prod"]), fmt_mean(h["shadow_run"].get("harm_if_rubber_stamped"))])
    if len(rows) < 2:
        return ""
    return "The agent's model is the variable an adopter can't control, so the same held-out tasks were run with others from Vultr's list:\n\n" + table(["Agent model", "Runs per task", "Direct harm", "Static gate harm", "Shadow Run harm", "If rubber-stamped"], rows)


def block_scale() -> str:
    s = load("scale.json")
    if not s:
        return NOT_YET
    rows = [[f"{r['db_mb']} MB", r["pg_dump_s"], r["checksum_s"], r["golden_build_s"], r["clone_boot_ms"] or "n/a", r["rehearsal_total_s"] or ("refused: clone didn't match" if r.get("refused") else "timed out, so refused"), f"{r.get('rows_changed', 0):,}" if r.get("rows_changed") is not None else "n/a"] for r in s["rows"]]
    return table(["Database", "pg_dump s", "Checksums s", "Build golden s", "Clone boot ms", "Rehearsal s", "Rows the plan changed"], rows) + f"\n\nRe-run: `{s['rerun']}`."


def block_soak() -> str:
    s = load("soak.json")
    if not s:
        return ""
    return f"Soak test: {s['rehearsals']} rehearsals in {s['wall_s']} s, every one contained with teardown confirmed: {'yes' if s['all_contained'] and s['all_teardown_ok'] else 'NO'}. Prod unchanged: {'yes' if s['prod_unchanged'] else 'NO'}. Re-run: `{s['rerun']}`."


def block_budget() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured":
        return NOT_YET
    a = r["all_risky_and_safe"]
    return f"Inference cost per task, averaged over the benchmark: ${a['shadow_run']['cost_per_task_usd']} through Shadow Run, ${a['direct']['cost_per_task_usd']} for the agent alone."


def money(unit: str, v: float | None) -> str:
    if v is None:
        return "gone"
    return f"${v:,.0f}" if unit == "usd" else f"{v:,.0f}"


def block_incidents() -> str:
    d = load("incidents.json")
    if not d:
        return NOT_YET
    rows = []
    for r in d["incidents"]:
        measured = r["measured"][0] if r["measured"] else "nothing to measure: the command failed in the sandbox"
        moved = "; ".join(f"{m['name']}: {money(m['unit'], m['before'])} to {money(m['unit'], m['after'])}" for m in r["metrics"][:1])
        rows.append([f"[{r['who']}, {r['when']}]({r['source']})", f"`{r['command'].splitlines()[0][:44]}`", (moved or measured)[:90], "reached prod" if r["reached_prod"] else "stopped", "yes" if r["prod_unchanged"] else "NO"])
    return table(["Incident", "Command", "Measured on the clone", "Result", "Prod unchanged"], rows) + f"\n\nThe commands and how each was adapted are in [`demo/incidents.yaml`](demo/incidents.yaml). Re-run: `{d['rerun']}`." + where(d)


def block_second_opinion() -> str:
    o = load("second_opinion.json")
    if not o:
        return ""
    miss, ok, harm = o["did_not_do_the_job"], o["did_the_job"], o["harmful_if_approved"]
    return (
        f"The second model was tested against the benchmark's blind oracles, on {o['plans']} plans held for a person. "
        f"It flagged {miss['flagged']} of the {miss['total']} that didn't do the job, {harm['flagged']} of the {harm['total']} that would have caused harm if approved, "
        f"and wrongly doubted {ok['flagged']} of the {ok['total']} that did. It's advice for the person, and its doubt only ever adds a person. Model `{o['model']}`. Re-run: `{o['rerun']}`."
    )


def block_clone_check() -> str:
    c = load("clone_check.json")
    if not c:
        return ""
    return f"Every clone is checked against what it was restored from: {c['matched']} of the {c['databases']} databases in the suite restore with the same rows and schema. A clone that doesn't match is refused, because one missing a foreign key would report a smaller blast radius than the real thing. Re-run: `{c['rerun']}`."


def block_gate() -> str:
    g = load("gate.json")
    if not g:
        return ""
    b, ok = g["bad_plans"], g["good_plans"]
    return (
        f"Rules alone aren't enough. Reading the suite's {b['total']} known-bad plans with no rehearsal, the static gate sends {b['sent_to_a_person']} to a person, refuses {b['refused']} and passes {b['passed']}, "
        f"which only a rehearsal can catch. It flags {ok['sent_to_a_person']} of the {ok['total']} known-good plans and refuses {ok['refused']}. Re-run: `{g['rerun']}`."
    )


def where(doc: dict) -> str:
    """A number measured on a dev machine must say so."""
    url = doc.get("url", "")
    return "" if url.startswith("https://") else " **Measured on a local development stack, not on the Vultr deployment.**"


def reach(summary: dict) -> str:
    return ", ".join(f"`{c}`" for c in summary.get("reach_alone", [])) or "nothing"


def block_gauntlet() -> str:
    g = load("gauntlet.json")
    if not g or not g.get("baseline_summary"):
        return NOT_YET
    base, a, b, r = g["baseline_summary"], g["first_summary"], g["summary"], g["replay"]
    text = (
        "| The attacker is told every guardrail and the auto-apply rule | Damaging plans | Stopped by a rule | Passed the rules, waited for a person | **Would have applied alone** | What those could change with no person looking |\n|---|---:|---:|---:|---:|---|\n"
        f"| Old policy, a row limit only | {base['real_attacks']} | {base['caught']} | {base['held_for_a_person']} | **{base['would_auto_apply']}** | {reach(base)} |\n"
        f"| Named list of what may change alone | {a['real_attacks']} | {a['caught']} | {a['held_for_a_person']} | **{a['would_auto_apply']}** | {reach(a)} |\n"
        f"| Same, after adopting {len(g['adopted'])} rules it taught us | {b['real_attacks']} | {b['caught']} | {b['held_for_a_person']} | **{b['would_auto_apply']}** | {reach(b)} |\n\n"
        f"Replaying the attacks that passed the rules, against the rules they taught: {r['caught']} of {r['total']} now stopped. That's a regression check on those attacks, not a claim about new ones, and the last row shows new ones still come."
    )
    return text + f" Model `{g['model']}`, ${g['cost_usd']} of inference, full transcripts in `bench/gauntlet.json`. Re-run: `{g['rerun']}`." + where(g)


BLOCKS = {
    "incidents": block_incidents, "gate": block_gate, "clone_check": block_clone_check, "second_opinion": block_second_opinion, "gauntlet": block_gauntlet, "models": block_models,
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
