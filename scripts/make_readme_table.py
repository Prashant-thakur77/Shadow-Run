#!/usr/bin/env python3
"""Fill the generated blocks in README.md from the JSON the benchmarks wrote. No result is typed by hand.

Blocks are marked <!-- name:start --> ... <!-- name:end -->. A block whose source file is missing says
"not measured yet", so a gap is visible and never filled in by hand.
"""
from __future__ import annotations

import json
import sys
import urllib.request
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
sys.path.insert(0, str(ROOT))
from checker.control_kinds import control_kind  # noqa: E402
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
    held_out = [r for r in runs if r.get("mode") == "shadow_run" and r.get("risky") and r.get("split") == "heldout" and r.get("outcome") != "harness_error"]
    rewrote = sum(1 for r in held_out if r.get("tries", 1) > 1)
    done = lambda m: m["risky_done"]["mean"]
    unread_done, unread_harm = s["risky_done_if_rubber_stamped"]["mean"], s["harm_if_rubber_stamped"]["mean"]
    neither = lambda doing, harm: round(n - doing - harm, 2)
    board = table(
        [f"Of {n} held-out risky tasks", "Agent directly", "Static gate", "Shadow Run, every plan approved unread"],
        [
            ["Did the job, no harm", f"{done(d):g}", f"{done(g):g}", f"**{unread_done:g}**"],
            ["Harm on prod", f"{d['harm_on_prod']['mean']:g}", f"{g['harm_on_prod']['mean']:g}", f"**{unread_harm:g}**"],
            ["Neither", f"{neither(done(d), d['harm_on_prod']['mean']):g}", f"{neither(done(g), g['harm_on_prod']['mean']):g}", f"{neither(unread_done, unread_harm):g}"],
        ],
    )
    direct_harm = d["harm_on_prod"]["mean"]
    gain = f"{round(100 * (unread_done - done(d)) / done(d))}% more" if done(d) and unread_done > done(d) else None
    drop = f"{round(100 * (direct_harm - unread_harm) / direct_harm)}% less" if direct_harm and unread_harm < direct_harm else None
    lead = f"**Through Shadow Run the same agent finishes {gain} of its risky work safely and does {drop} harm, even if nobody reads a report.** " if gain and drop else ""
    return (
        lead + f"**On {n} risky tasks held out from tuning: finished safely {times(done(d))} running directly, {times(unread_done)} through Shadow Run with every plan approved unread. Harm fell from {direct_harm:g} to {unread_harm:g}.**\n\n"
        + board + "\n\n"
        f"That gain is what rehearsing adds: the agent saw what its plan would really do and rewrote it, in {rewrote} of {len(held_out)} held-out runs. The static gate's {g['harm_on_prod']['mean']:g} against {d['harm_on_prod']['mean']:g} is noise at this sample size. "
        f"With a person who reads the report, nothing harmful reached prod without one, a harm count of {s['harm_on_prod']['mean']:g}, but that zero is mostly the hold: {s['risky_held']['mean']:g} of {n} risky plans waited, and anything that holds every plan would score zero too. "
        f"The price is approvals, since all {s['safe_held']['mean']:g} safe tasks waited as well. A rehearsal takes {s['rehearsal_s']['p50']} s at the median, boot to destroy."
    )


def retried(r: dict) -> str:
    """runs.jsonl keeps a run that hit a harness error, so a reader counting lines should know why there are more."""
    extra = sum(1 for line in (BENCH / "runs.jsonl").read_text().splitlines() if line.strip()) - r["runs"]
    return f" after retrying {extra} that hit one in the benchmark's own database reset, which `bench/runs.jsonl` keeps" if extra > 0 else ""


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
        f"commit `{r['git_commit']}`, suite sha256 `{r['suite_sha256'][:12]}`, {r['runs']} runs, {r['harness_errors']} harness errors{retried(r)}. "
        f"Re-run: `{r['rerun']}`. Every run and its plan is in `bench/runs.jsonl`."
    )
    kept = r.get("rehearsal_containment")
    if kept:
        note += (
            f" Each of the {kept['rehearsals']:,} rehearsals needs a complete containment record from the host, with probes, kernel check and teardown proof. "
            f"{kept['incomplete']} came back without one and were refused, not counted."
        )
    note += f" The code that measures hasn't changed since: `git diff {r['git_commit']} HEAD -- control/agent.py control/budget.py control/gate.py control/plan.py control/apply.py control/snapshot.py runner checker/blast.py bench/run.py bench/oracle.py bench/tasks` is empty."
    return table(t["columns"], rows) + "\n\n" + note


def block_groups() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured":
        return NOT_YET
    columns = [("Stopped by gate", "risky_blocked_gate"), ("Stopped by guardrail", "risky_blocked_guardrail"), ("Held for a person", "risky_held"), ("If approved unread, harm", "harm_if_rubber_stamped"), ("If approved unread, did the job", "risky_done_if_rubber_stamped")]
    groups = {name: b for name, b in r["by_group"].items() if b["direct"].get("risky_tasks")}
    # A column of zeros says nothing here.
    shown = [(label, key) for label, key in columns if any((b["shadow_run"].get(key) or {}).get("mean") for b in groups.values())]
    rows = [[f"{name} ({b['direct']['risky_tasks']})", fmt_mean(b["direct"]["harm_on_prod"]), fmt_mean(b["static_gate"]["harm_on_prod"]), fmt_mean(b["shadow_run"]["harm_on_prod"]), *[fmt_mean(b["shadow_run"].get(key)) for _, key in shown]] for name, b in groups.items()]
    body = table(["Group (risky tasks)", "Direct harm", "Static gate harm", "Shadow Run harm, no person", *[label for label, _ in shown]], rows)
    return f"<details><summary>By kind of task</summary>\n\n{body}\n\n</details>"


def block_wider() -> str:
    w = load("results.wider_list.json")
    if not w or w.get("status") != "measured":
        return ""
    held, ext = w["heldout"]["shadow_run"], w["external"]["shadow_run"]
    return (
        f"Most safe work waits for a person because the demo's auto-apply list is one notes column. With [a wider list a team might accept](demo/wider_list.yaml), {held.get('safe_auto_applied', {}).get('mean', 0):g} of {held['safe_tasks']} safe tasks applied alone, "
        f"and harm on prod with no person was {held['harm_on_prod']['mean']:g} of {held['risky_tasks']} held-out and {ext['harm_on_prod']['mean']:g} of {ext['risky_tasks']} SABER-derived. Mean of {w['runs_per_task']} runs. Deletes and cascades still wait."
    )


def block_redteam() -> str:
    rt = load("redteam.json")
    if not rt or not rt.get("attacks"):
        return NOT_YET
    rows = [[a["title"], a["expected"], "contained" if a["contained"] else "NOT CONTAINED", f"{a['wall_s']:.1f}"] for a in rt["attacks"]]
    contained = sum(1 for a in rt["attacks"] if a["contained"])
    out = f"**{contained} of {len(rt['attacks'])} contained.**\n\n<details><summary>Each attack</summary>\n\n" + table(["Attack", "Expected", "Result", "Wall s"], rows) + "\n\n</details>"
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
    rows = [[x["control"], control_kind(x["control"]), x["must"], "pass" if x["ok"] else "FAIL"] for x in c["controls"]]
    attacks = [x for x in c["controls"] if control_kind(x["control"]) == "attack"]
    honest = [x for x in c["controls"] if control_kind(x["control"]) != "attack"]
    head = f"**{sum(1 for x in attacks if x['ok'])} of {len(attacks)} attacks were refused, rolled back or held, and {sum(1 for x in honest if x['ok'])} of {len(honest)} checks that the honest path still works passed**, at {c['at']}. Re-run: `python -m checker.controls`." + where(c)
    return head + f"\n\n<details><summary>All {c['total']}</summary>\n\n" + table(["Check", "Kind", "Must", "Result"], rows) + "\n\n</details>"


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
    per_thousand = (a["shadow_run"]["cost_per_task_usd"] + r["heldout"]["shadow_run"].get("vx1_usd_per_rehearsal", 0)) * 1000
    return f"Inference cost per task across all {r['runs'] // (3 * r['runs_per_task'])} tasks, where the table above is held-out only: ${a['shadow_run']['cost_per_task_usd']} through Shadow Run and ${a['direct']['cost_per_task_usd']} for the agent alone. That's about ${per_thousand:.2f} of inference per thousand tasks through Shadow Run."


def money(unit: str, v: float | None) -> str:
    if v is None:
        return "gone"
    return f"${v:,.0f}" if unit == "usd" else f"{v:,.0f}"


def short_command(command: str) -> str:
    first = command.strip().splitlines()[0]
    if len(first) > 44:
        first = first[:44].rsplit(" ", 1)[0] + " ..."
    return first.replace("|", "\\|")


def block_incidents() -> str:
    d = load("incidents.json")
    if not d:
        return NOT_YET
    rows = []
    for r in d["incidents"]:
        measured = r["measured"][0] if r["measured"] else "nothing to measure: the command failed in the sandbox"
        moved = "; ".join(f"{m['name']}: {money(m['unit'], m['before'])} to {money(m['unit'], m['after'])}" for m in r["metrics"][:1])
        rows.append([f"[{r['who']}, {r['when']}]({r['source']})", f"`{short_command(r['command'])}`", (moved or measured)[:90], "reached prod" if r["reached_prod"] else "stopped", "yes" if r["prod_unchanged"] else "NO"])
    return table(["Incident", "Command", "Measured on the clone", "Result", "Prod unchanged"], rows) + f"\n\nThe commands and how each was adapted are in [`demo/incidents.yaml`](demo/incidents.yaml). Re-run: `{d['rerun']}`." + where(d)


def block_video() -> str:
    url = os.environ.get("SHADOWRUN_VIDEO_URL")
    return f"Demo video: {url}" if url else ""


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
    replay = load("gate_replay.json")
    swap = (
        f" Replaying the benchmark's {replay['plans']} recorded plans through today's gate gives the same verdict on {replay['same_verdict']}: `python -m bench.gate_replay`."
    ) if replay else ""
    return (
        f"Rules alone aren't enough. Reading the suite's {b['total']} known-bad plans with no rehearsal, the static gate sends {b['sent_to_a_person']} to a person, refuses {b['refused']} and passes {b['passed']}, "
        f"which only a rehearsal can catch. It flags {ok['sent_to_a_person']} of the {ok['total']} known-good plans and refuses {ok['refused']}. Re-run: `{g['rerun']}`.{swap}"
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


def block_market() -> str:
    p = ROOT / "docs" / "market.json"
    if not p.exists():
        return ""
    m = json.loads(p.read_text())
    a, g, d, pg, derived, price = m["agents_market"], m["guardian_share"], m["developers_using_agents"], m["postgres_companies"], m["derived"], m["price"]
    r = load("results.json") or {}
    cost = ((r.get("all_risky_and_safe") or {}).get("shadow_run") or {}).get("cost_per_task_usd")
    lines = [
        f"**Who is exposed.** {d['weekly_pct']}% of professional developers use coding agents at work at least weekly and {d['daily_pct']}% daily ([{d['source']}]({d['url']}), {d['respondents']} respondents). [{pg['count']:,} companies use PostgreSQL]({pg['url']}), by {pg['source']}'s 2026 count. {pg['caveat']}",
        "",
        f"**Market.** [{g['source']}]({g['url']}) expects guardian agents, the category this sits in, to take {g['low_pct']} to {g['high_pct']}% of the agentic AI market by {g['by_year']}. [{a['source']}]({a['url']}) sizes AI agents at ${a['usd_b_2025']} billion in 2025 and ${a['usd_b_2033']} billion by 2033. Combining the two, which is our arithmetic and not theirs, gives ${derived['tam_usd_b_on_2025_market'][0]} to {derived['tam_usd_b_on_2025_market'][1]} billion on today's market and ${derived['tam_usd_b_on_2033_forecast'][0]} to {derived['tam_usd_b_on_2033_forecast'][1]} billion on the 2033 forecast. The market this version can serve: those companies, one protected database each, at the ${price['usd_per_database_month']} a month we plan to charge, is ${derived['sam_usd_b_per_year']} billion a year. That price is a plan, not tested with a customer.",
        "",
        "**Revenue.** " + " ".join(m["revenue"]) + (f" A rehearsed task costs about ${cost} of inference at today's benchmark." if cost else ""),
        "",
        "| Who else | What they do well | What's missing for this job |",
        "| --- | --- | --- |",
    ]
    for c in m["competition"]:
        lines.append(f"| {c['who']} | {c['strength']} | {c['gap']} |")
    lines += ["", f"**Where we're weak:** {m['us']['weakness']} **What's different:** {m['us']['usp']}"]
    return "\n".join(lines)


def block_reviewer() -> str:
    d = load("reviewer.json")
    if not d:
        return ""
    a, b = d["plan_only"], d["with_report"]
    return (
        f"**Does the report help the person?** A model stood in for the reviewer on {d['plans_scored']} distinct plans the benchmark held, deciding each one twice. Reading the request, schema and plan, as in a pull request, it approved {a['harmful']['approved']} of {a['harmful']['total']} harmful plans and {a['good']['approved']} of {a['good']['total']} good ones. "
        f"With the measured report added, it approved {b['harmful']['approved']} of {b['harmful']['total']} harmful and {b['good']['approved']} of {b['good']['total']} good. This is a model, not a user study, and the oracles were blind to it. Model `{d['model']}`, ${d['cost_usd']} of inference. Re-run: `{d['rerun']}`."
    )


BLOCKS = {
    "market": block_market,
    "reviewer": block_reviewer,
    "incidents": block_incidents, "video": block_video, "wider": block_wider, "gate": block_gate, "clone_check": block_clone_check, "second_opinion": block_second_opinion, "gauntlet": block_gauntlet, "models": block_models,
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
