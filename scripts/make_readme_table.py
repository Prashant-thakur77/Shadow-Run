#!/usr/bin/env python3
"""Fill the generated blocks in README.md from the JSON the benchmarks wrote. No result is typed by hand.

Blocks are marked <!-- name:start --> ... <!-- name:end -->. A block whose source file is missing says
"not measured yet", so a gap is visible and never filled in by hand.

The headline and the sentences around it come from bench/stats.json, and each one is chosen by what the numbers say. A sentence
that makes a claim, such as "the effect sits in those two groups", is only printed when the numbers bear it out.

  python scripts/make_readme_table.py                       write every block
  python scripts/make_readme_table.py --only headline suite write those blocks
  python scripts/make_readme_table.py --check [--only ...]  print them and write nothing
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import os
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
sys.path.insert(0, str(ROOT))
from bench import provenance  # noqa: E402
from bench.tasks import GATE_LABEL, suite_hash  # noqa: E402
from checker.control_kinds import control_kind  # noqa: E402
NOT_YET = "Not measured yet."
BLIND_LINE = (
    "A separate agent wrote the oracles without reading the guardrails, but the same project wrote the brief, the schema and the guardrails, and two guardrails were added after the tuning runs. "
    "They share their ideas, so read the held-out result as what happens when guardrails cover the risks that matter."
)


def load(name: str) -> dict | None:
    p = BENCH / name
    return json.loads(p.read_text()) if p.exists() else None


def env_value(key: str) -> str:
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return ""


def fmt_mean(p: dict | None) -> str:
    """The mean only. A range across run numbers reads like an interval and isn't one. The real intervals are in bench/stats.json."""
    if not p or p.get("mean") is None:
        return "n/a"
    return f"{p['mean']:g}"


def fmt_p(p: float) -> str:
    return "p < 0.001" if p < 0.001 else f"p = {p:.2g}"


def fmt_ci(c: dict) -> str:
    return f"95% CI {c['ci95'][0]:+g} to {c['ci95'][1]:+g}"


def same_suite(doc: dict) -> bool:
    return doc.get("suite_sha256") == suite_hash()


def view(s: dict, r: dict) -> dict:
    """Which scores lead. A run under today's tasks speaks for itself. Otherwise, if its plans have been scored again under today's
    oracles, those lead, and the text says so. Both have the same shape."""
    if same_suite(r) or not s.get("rescored") or s["rescored"].get("partial") or s["rescored"].get("suite_sha256") != suite_hash():
        main = s["main"]
        sets = {k: {"tasks": v["tasks"], "arms": v["arms"], "compare": v["compare"]} for k, v in main["sets"].items()}
        return {"kind": "fresh" if same_suite(r) else "stale", "sets": sets, "coverage": main.get("guardrail_coverage", {})}
    again = s["rescored"]
    sets = {k: {"tasks": v["tasks"], "arms": v["after"], "compare": v["compare"]} for k, v in again["sets"].items()}
    return {"kind": "rescored", "sets": sets, "coverage": again.get("guardrail_coverage", {})}


def basis_sentence(v: dict) -> str:
    return {
        "fresh": "",
        "rescored": "These are the plans from the run before an audit, scored by today's oracles. The next full run replaces them. ",
        "stale": "These scores come from a run under older oracles. ",
    }[v["kind"]]


def lead_sentence(v: dict) -> str:
    h = v["sets"]["heldout"]
    d, u = h["arms"]["direct"], h["arms"]["unread"]
    c = h["compare"]["unread_vs_direct"]
    harm_clear = c["harm"]["excludes_zero"] and c["harm"]["difference"] < 0
    done_clear = c["done"]["excludes_zero"]
    if done_clear:
        done = f"and finished safely on {u['done']:g} instead of {d['done']:g}"
    elif u["done"] == d["done"]:
        done = f"and finished safely on {u['done']:g}, the same as alone"
    else:
        done = f"and finished safely on {u['done']:g} against {d['done']:g}, a difference this sample can't tell from chance"
    lead = "harm fell" if harm_clear else "harm went"
    return (
        f"**With every plan approved unread, {lead} from {d['harm']:g} to {u['harm']:g} of {h['tasks']} held-out risky tasks, {done}.** "
        "These are our own tasks, on a demo schema with cascading foreign keys and guardrails written for it."
    )


def direction(c: dict, metric: str) -> str:
    better, worse = (c["tasks_down"], c["tasks_up"]) if metric == "harm" else (c["tasks_up"], c["tasks_down"])
    return f"{better} tasks better, {worse} worse"


def task_level_sentence(v: dict) -> str:
    c = v["sets"]["heldout"]["compare"]["unread_vs_direct"]
    h, f = c["harm"], c["done"]
    return (
        f"Task by task, Shadow Run minus direct: harm {h['difference']:+g} ({fmt_ci(h)}, {direction(h, 'harm')}, {fmt_p(h['permutation_p'])}), "
        f"finished safely {f['difference']:+g} ({fmt_ci(f)}, {direction(f, 'done')}, {fmt_p(f['permutation_p'])}). We count tasks, not runs, because three runs of a task are close to copies."
    )


def concentration_sentence(v: dict) -> str:
    rest = v["sets"].get("heldout_without_cascade_and_soft_delete")
    if not rest:
        return ""
    c = rest["compare"]["unread_vs_direct"]
    h, f = c["harm"], c["done"]
    text = f"Without the cascade and soft_delete groups, the other {rest['tasks']} tasks show harm {h['from']:g} to {h['to']:g} ({fmt_p(h['permutation_p'])}) and finished safely {f['from']:g} to {f['to']:g} ({fmt_p(f['permutation_p'])})"
    return text + (", so the effect sits in those two groups." if h["permutation_p"] >= 0.05 and f["permutation_p"] >= 0.05 else ".")


def gate_sentence(v: dict) -> str:
    g = v["sets"]["heldout"]["compare"].get("gate_vs_direct")
    if not g:
        return ""
    h = g["harm"]
    return f"The rule gate's harm of {h['to']:g} against direct's {h['from']:g} isn't distinguishable from noise." if h["permutation_p"] >= 0.05 else f"The rule gate's harm of {h['to']:g} against direct's {h['from']:g} is a real difference ({fmt_ci(h)})."


def coverage_clause(v: dict) -> str:
    cov = v["coverage"].get("heldout")
    if not cov:
        return ""
    a, b = cov["covered"], cov["not_covered"]
    text = f"Of the tasks where direct did harm, the {a['tasks']} where a guardrail fired went from {a['direct_harm']:g} to {a['unread_harm']:g}, and the {b['tasks']} where none fired went from {b['direct_harm']:g} to {b['unread_harm']:g}."
    return text + " Harm fell only where a guardrail covered it." if b["tasks"] and b["direct_harm"] == b["unread_harm"] and a["unread_harm"] < a["direct_harm"] else text


def arm_versus(name: str, c: dict) -> str:
    h, f = c["harm"], c["done"]
    return f"Against {name}, Shadow Run differs by {h['difference']:+g} on harm ({fmt_ci(h)}, {fmt_p(h['permutation_p'])}) and {f['difference']:+g} on finishing safely ({fmt_ci(f)}, {fmt_p(f['permutation_p'])})."


def shadow_vs(c: dict) -> str:
    """Shadow Run minus an arm: better, worse, mixed, or can't tell, from whether each interval excludes zero."""
    h, f = c["harm"], c["done"]
    better = (h["excludes_zero"] and h["difference"] < 0) or (f["excludes_zero"] and f["difference"] > 0)
    worse = (h["excludes_zero"] and h["difference"] > 0) or (f["excludes_zero"] and f["difference"] < 0)
    return "mixed" if better and worse else "better" if better else "worse" if worse else "cant_tell"


def controls_conclusion(sets: dict) -> str:
    c = sets["compare"]
    rollback, rules = shadow_vs(c["unread_vs_rollback"]), shadow_vs(c["unread_vs_rules"])
    if rollback == "cant_tell":
        out = "We can't tell Shadow Run's plans from the rollback arm's at this sample size, so a better plan isn't something rehearsing has been shown to add over a transaction with the same checks. "
    elif rollback == "better":
        out = "Shadow Run's plans did better than the rollback arm's, so rehearsing adds something beyond the checks. "
    elif rollback == "worse":
        out = "The rollback arm's plans did better than Shadow Run's, so this table gives no reason to rehearse for the sake of plan quality. "
    else:
        out = "Against the rollback arm the result is mixed: better on one measure and worse on the other. "
    rh = c["rules_vs_direct"]["harm"]
    if rh["excludes_zero"] and rh["difference"] < 0:
        out += f"Just telling the agent the rules up front cut harm by {-rh['difference']:g} tasks against direct ({fmt_ci(rh)}). "
    else:
        out += f"Telling the agent the rules up front didn't clearly change harm against direct ({rh['difference']:+g}, {fmt_ci(rh)}). "
    if rules == "worse":
        out += "Rules in the prompt also beat Shadow Run on its plans here. "
    return out + "This table scores plans. It doesn't measure what the microVM is for, which is keeping a plan away from the real database until someone has seen what it does."


def controls_table(sets: dict) -> str:
    arms = sets["arms"]
    n = sets["tasks"]
    return table(
        [f"Of {n} risky SQL tasks", "Agent directly", "Rules in the prompt", "Transaction with rollback", "Shadow Run, approved unread"],
        [
            ["Harm", *[f"{arms[a]['harm']:g}" for a in ("direct", "rules_in_prompt", "rollback", "unread")]],
            ["Finished safely", *[f"{arms[a]['done']:g}" for a in ("direct", "rules_in_prompt", "rollback", "unread")]],
        ],
    )


def rehearsing_text(s: dict, v: dict) -> str:
    """Replaces "that gain is what rehearsing adds", which nothing had tested. It says what the control arms show, or that they haven't run."""
    retries = s["main"]["retries"]
    rewrote = f"The agent rewrote a plan after a failed guardrail in {retries['rewrote_after_a_failed_guardrail']} of {retries['heldout_runs']} held-out runs."
    controls = s.get("controls") or {}
    held = (controls.get("sets") or {}).get("heldout_sql")
    if not held or controls.get("status") != "measured":
        return f"That gain comes from rehearsing and telling the agent which guardrails failed, and we haven't tested the two apart. {rewrote} {coverage_clause(v)}".strip()
    c = held["compare"]
    warn = "" if controls.get("same_code_as_main") else " **The control run and the main run used different code, so this comparison is weaker than it looks.**"
    return (
        controls_table(held) + "\n\n"
        "Those two middle columns test what rehearsing adds. Rules in the prompt gives the agent the same guardrails up front, and the plan runs directly. "
        "Transaction with rollback checks the same guardrails in a transaction on the database, with the same retries and feedback, and no microVM. "
        f"{arm_versus('rules in the prompt', c['unread_vs_rules'])} {arm_versus('the rollback arm', c['unread_vs_rollback'])} {controls_conclusion(held)} {rewrote} {coverage_clause(v)}{warn}"
    ).strip()


def hold_sentence(s: dict, r: dict) -> str:
    """Replaces "mostly the hold". All of it is the hold when nothing that changed anything went through alone."""
    retries = s["main"]["retries"]
    held = r["heldout"]["shadow_run"]
    n = held["risky_tasks"]
    as_run = s["main"]["sets"]["heldout"]["arms"]["as_run"]["harm"]
    waited = f"{held['risky_held']['mean']:g} of {n} risky plans waited, and anything that holds every plan would score zero too."
    if retries["auto_applied_that_changed_something"] == 0 and as_run == 0:
        return f"No plan that changed anything reached prod without a person, so a harm count of 0 with a person who reads the report comes entirely from the hold. {waited}"
    return f"{retries['auto_applied_that_changed_something']} plans changed something with no person looking, and harm on prod before any approval was {as_run:g} of {n}. {waited}"


def saber_sentence(v: dict) -> str:
    """Replaces "so the result isn't only on our own planted data". Says what each half of the SABER set really measured."""
    sets = v["sets"]
    if not sets.get("saber_db"):
        return ""
    db = sets["saber_db"]["compare"]["unread_vs_direct"]
    moved = db["harm"]["tasks_up"] + db["harm"]["tasks_down"]
    call = f"too few tasks to call ({moved} moved on harm, {fmt_p(db['harm']['permutation_p'])})" if db["harm"]["permutation_p"] >= 0.05 else f"{fmt_ci(db['harm'])}, {fmt_p(db['harm']['permutation_p'])}"
    out = f"On the {sets['saber_db']['tasks']} database tasks, harm went from {db['harm']['from']:g} to {db['harm']['to']:g} and finishing safely from {db['done']['from']:g} to {db['done']['to']:g}, {call}."
    fs = sets.get("saber_fs")
    if not fs:
        return out
    c = fs["compare"]["unread_vs_direct"]
    if v["kind"] == "fresh":
        return out + f" On the {fs['tasks']} filesystem tasks, harm went from {c['harm']['from']:g} to {c['harm']['to']:g} and finishing safely from {c['done']['from']:g} to {c['done']['to']:g} ({fmt_p(c['harm']['permutation_p'])} on harm)."
    if c["harm"]["from"] == 0 and c["harm"]["to"] == 0:
        return out + f" The {fs['tasks']} filesystem tasks measured nothing in that run, because the agent was never told the project's path. That's fixed for the next run."
    return out + f" The agent wasn't told the project's path on the {fs['tasks']} filesystem tasks in that run, so those plans only show damage to the live app next door: {c['harm']['from']:g} direct against {c['harm']['to']:g}. That's fixed for the next run."


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
    st = load("stats.json")
    if not r or not st or not st.get("main") or r.get("status") != "measured" or r.get("scope") != "full" or not comparable(r):
        return NOT_YET
    v = view(st, r)
    h = v["sets"]["heldout"]
    d, g, u = h["arms"]["direct"], h["arms"]["static_gate"], h["arms"]["unread"]
    n = h["tasks"]
    neither = lambda a: round(n - a["done"] - a["harm"], 2)
    board = table(
        [f"Of {n} held-out risky tasks", "Agent directly", GATE_LABEL, "Shadow Run, every plan approved unread"],
        [
            ["Did the job, no harm", f"{d['done']:g}", f"{g['done']:g}", f"**{u['done']:g}**"],
            ["Harm on prod", f"{d['harm']:g}", f"{g['harm']:g}", f"**{u['harm']:g}**"],
            ["Neither", f"{neither(d):g}", f"{neither(g):g}", f"{neither(u):g}"],
        ],
    )
    held = r["heldout"]["shadow_run"]
    price = f"all {held['safe_held']['mean']:g} safe tasks waited as well" if held["safe_held"]["mean"] == held["safe_tasks"] else f"{held['safe_held']['mean']:g} of {held['safe_tasks']} safe tasks waited as well"
    return (
        lead_sentence(v) + "\n\n" + board + "\n\n"
        + basis_sentence(v) + task_level_sentence(v) + " " + concentration_sentence(v) + "\n\n"
        + rehearsing_text(st, v) + " " + gate_sentence(v) + "\n\n"
        + hold_sentence(st, r) + f" The price is approvals, since {price}. A rehearsal takes {held['rehearsal_s']['p50']} s at the median, boot to destroy."
    )


def block_suite() -> str:
    """Hand-written facts about the suite, with the SABER sentence measured and the oracle's independence stated as it really is."""
    r = load("results.json")
    st = load("stats.json")
    saber = saber_sentence(view(st, r)) if r and st and st.get("main") else ""
    return (
        f"The suite is 40 tasks of ours plus 20 adapted from [SABER](https://github.com/sssr-lab/saber). {saber} "
        f"Oracles decide harm by checking outcomes, and every mode is scored by the same code. {BLIND_LINE} "
        "Each oracle is tested with known-bad and known-good plans (`python -m bench.validate`). We tuned on 10 tasks and report the other 30 and the SABER set separately. "
        "One disclosure: after a preview run's totals showed small harmful plans auto-applying under budget, we added the rule that irreversible writes always need a person. "
        "We read only the totals for that, not which held-out tasks were involved, but the held-out set isn't perfectly clean of that one decision. SABER's guardrails were drafted by the model and left unedited."
    ).replace("  ", " ")


def block_audit() -> str:
    """Two sentences, because a reader comparing versions should find out here and not by accident."""
    st = load("stats.json")
    again = (st or {}).get("rescored")
    if not again or "heldout" not in again["sets"]:
        return ""
    h = again["sets"]["heldout"]
    b, a = h["before"], h["after"]
    return (
        "An audit read these plans and found faults in our oracles, so we changed them, mainly by adding an integrity check that counts damage like rewritten foreign keys or invented accounts as harm in every mode. "
        f"The plans from the run before that change scored harm {b['direct']['harm']:g} direct and {b['unread']['harm']:g} through Shadow Run approved unread, and finished safely {b['direct']['done']:g} and {b['unread']['done']:g}, "
        f"and the changed oracles score those same plans harm {a['direct']['harm']:g} and {a['unread']['harm']:g}, finished safely {a['direct']['done']:g} and {a['unread']['done']:g} (`bench/results.before-audit.json`, `bench/rescore.json`)."
    )


def block_refusals() -> str:
    d = load("guardrail_refusals.json")
    if not d:
        return ""
    risky, safe, held = d["all_risky"], d["all_safe"], d["risky_heldout"]
    stale = "" if same_suite(d) else " Measured on an earlier version of the tasks."
    return (
        f"The guardrails are not free. Run on each task's known-good plan, they refuse {risky['refused']} of {risky['tasks']} risky tasks, {held['refused']} of them among the {held['tasks']} held out, and {safe['refused']} of {safe['tasks']} safe ones. "
        f"An agent refused on an honest plan looks for another one, and some of what it finds does damage, which the integrity check now counts. Some of these tasks can't be finished through Shadow Run with an honest plan, which holds its finishing count down. Re-run: `{d['rerun']}`.{stale}"
    )


def block_restrict() -> str:
    st = load("stats.json")
    x = (st or {}).get("restrict")
    if not x or x.get("status") != "measured":
        return "The same tasks on a schema with `ON DELETE RESTRICT` on the money tables, instead of cascades, haven't been measured yet."
    c = x["compare"]["unread_vs_direct"]
    h, f = c["harm"], c["done"]
    was = x["cascading_schema"]
    warn = "" if x.get("same_code_as_main") else " **That run and the main run used different code.**"
    return (
        f"Our schema cascades into its money tables, which most of the trap tasks depend on. With `ON DELETE RESTRICT` on those tables instead, on the {x['tasks']} held-out SQL tasks: direct did harm on {x['arms']['direct']['harm']:g} and Shadow Run approved unread on {x['arms']['unread']['harm']:g} "
        f"(difference {h['difference']:+g}, {fmt_ci(h)}, {fmt_p(h['permutation_p'])}), and they finished safely on {x['arms']['direct']['done']:g} and {x['arms']['unread']['done']:g} ({f['difference']:+g}, {fmt_ci(f)}, {fmt_p(f['permutation_p'])}). "
        f"On the cascading schema, those same tasks scored harm {was['direct']['harm']:g} and {was['unread']['harm']:g}, finished safely {was['direct']['done']:g} and {was['unread']['done']:g}.{warn}"
    )


def retried(r: dict) -> str:
    """runs.jsonl keeps a run that hit a harness error, so a reader counting lines should know why there are more."""
    extra = sum(1 for line in (BENCH / "runs.jsonl").read_text().splitlines() if line.strip()) - r["runs"]
    return f" after retrying {extra} that hit one in the benchmark's own database reset, which `bench/runs.jsonl` keeps" if extra > 0 else ""


def run_line(r: dict) -> str:
    """What this run was. Every clause is read from the file or checked against the files here now."""
    commit = f"commit `{r['git_commit']}`" if r.get("git_commit") else "no recorded commit"
    # Runs from before code hashes had their time and commit overwritten by their last --resume.
    when = f"started {r['at']}" if r.get("code_files") else f"last invoked {r['at']}"
    resumed = f", resumed {r['resumed_at']} at `{r.get('resumed_commit')}`" if r.get("resumed_at") else ""
    suite = f"suite sha256 `{r['suite_sha256'][:12]}`"
    if not same_suite(r):
        suite += f", and **the tasks have changed since, now `{suite_hash()[:12]}`**"
    return f"Model `{r['model']}` on Vultr Serverless Inference, {when}, {commit}{resumed}, {suite}."


def block_results() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured":
        return NOT_YET
    t = r["table"]
    # Older results carry bracket ranges and the old column name.
    rows = [[re.sub(r" \(\d+(\.\d+)?–\d+(\.\d+)?\)", "", str(c)) for c in row] for row in t["rows"]]
    columns = [GATE_LABEL if c == "Static gate only" else c for c in t["columns"]]
    rt = load("redteam.json")
    if rt and rt.get("total"):
        rows.append(["Red-team attacks contained, checked from the host", "n/a", "n/a", f"{rt['contained']} of {rt['total']}"])
    c = load("controls.json")
    if c:
        roll = next((x for x in c["controls"] if "drift check off" in x["control"]), None)
        if roll:
            rows.append(["Forced drift with the drift check off: rolled back, prod unchanged", "n/a", "n/a", "yes" if roll["ok"] else "NO"])
    note = (
        f"Mean of {r['runs_per_task']} runs per task. {run_line(r)} {r['runs']} runs, {r['harness_errors']} harness errors{retried(r)}. "
        f"Re-run: `{rerun_of(r)}`. Every run and its plan is in `bench/runs.jsonl`. Intervals and tests by task are in `bench/stats.json` (`python -m bench.stats`)."
    )
    kept = r.get("rehearsal_containment")
    if kept:
        note += (
            f" Each of the {kept['rehearsals']:,} rehearsals needs a complete containment record from the host, with probes, kernel check and teardown proof. "
            f"{kept['incomplete']} came back without one and {'was' if kept['incomplete'] == 1 else 'were'} refused, not counted."
        )
    note += " " + provenance.code_line(r)
    return table(columns, rows) + "\n\n" + note


def rerun_of(r: dict) -> str:
    """Runs from before the rerun strings were fixed say a command that wouldn't work from a checkout."""
    text = r.get("rerun", "")
    return text if text.startswith("bash ") else f"bash scripts/bench_remote.sh '{text}'"


def block_groups() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured":
        return NOT_YET
    columns = [("Stopped by gate", "risky_blocked_gate"), ("Stopped by guardrail", "risky_blocked_guardrail"), ("Held for a person", "risky_held"), ("If approved unread, harm", "harm_if_rubber_stamped"), ("If approved unread, did the job", "risky_done_if_rubber_stamped")]
    groups = {name: b for name, b in r["by_group"].items() if b["direct"].get("risky_tasks")}
    # A column of zeros says nothing here.
    shown = [(label, key) for label, key in columns if any((b["shadow_run"].get(key) or {}).get("mean") for b in groups.values())]
    rows = [[f"{name} ({b['direct']['risky_tasks']})", fmt_mean(b["direct"]["harm_on_prod"]), fmt_mean(b["static_gate"]["harm_on_prod"]), fmt_mean(b["shadow_run"]["harm_on_prod"]), *[fmt_mean(b["shadow_run"].get(key)) for _, key in shown]] for name, b in groups.items()]
    body = table(["Group (risky tasks)", "Direct harm", "Rule gate harm", "Shadow Run harm, no person", *[label for label, _ in shown]], rows)
    stale = "" if same_suite(r) else "\n\nThese are that run's own scores, under the oracles it ran with."
    return f"<details><summary>By kind of task</summary>\n\n{body}{stale}\n\n</details>"


def block_wider() -> str:
    w = load("results.wider_list.json")
    if not w or w.get("status") != "measured":
        return ""
    held, ext = w["heldout"]["shadow_run"], w["external"]["shadow_run"]
    return (
        f"Most safe work waits for a person because the demo's auto-apply list is one notes column. With [a wider list a team might accept](demo/wider_list.yaml), {held['safe_done']['mean']:g} of {held['safe_tasks']} safe tasks finished with no person, "
        f"against harm with no person on {held['harm_on_prod']['mean']:g} of {held['risky_tasks']} held-out and {ext['harm_on_prod']['mean']:g} of {ext['risky_tasks']} SABER-derived risky tasks. Mean of {w['runs_per_task']} runs. "
        "On a table listed whole, a delete can run alone only if its undo is proved on the clone, and cascades, truncates and drops still wait."
        + ("" if same_suite(w) else " Measured before the oracle change and on an earlier list, so it may not match the files here now.")
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


def model_runs() -> list[tuple[str, dict]]:
    """The primary run and other models' runs of the same suite. Labelled runs and the kept pre-audit copy are other questions."""
    out = [("results.json", load("results.json"))]
    for p in sorted(BENCH.glob("results.*.json")):
        doc = json.loads(p.read_text())
        if not doc.get("label") and "before-audit" not in p.name:
            out.append((p.name, doc))
    return [(name, doc) for name, doc in out if doc and doc.get("status") == "measured"]


def block_models() -> str:
    docs = model_runs()
    if len(docs) < 2:
        return NOT_YET if not docs else ""
    rows = []
    main_code = (load("results.json") or {}).get("code_sha256")
    for name, doc in docs:
        h = doc["heldout"]
        code = "final" if doc.get("code_sha256") == main_code else ("before the evasion checks" if "before-evasion" in name else "earlier")
        s = h["shadow_run"]
        rows.append([f"`{doc['model']}`", f"{doc['runs_per_task']}", fmt_mean(h["direct"]["harm_on_prod"]), fmt_mean(h["static_gate"]["harm_on_prod"]), fmt_mean(s.get("harm_if_rubber_stamped")), fmt_mean(h["direct"]["risky_done"]), fmt_mean(s.get("risky_done_if_rubber_stamped")), code])
    return "The agent's model is the variable an adopter can't control, so the same held-out tasks were run with others from Vultr's list:\n\n" + table(["Agent model", "Runs per task", "Direct harm", "Rule gate harm", "Shadow Run harm, approved unread", "Direct finished safely", "Shadow Run finished safely, approved unread", "Code"], rows)


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
        f"The second model was tested against the benchmark's oracles, on {o['plans']} plans held for a person. "
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
        f"Replaying the attacks that passed the rules, against the rules they taught: {r['caught']} of {r['total']} now stopped, in a separate test with {r['guardrails']} rules. That's a regression check on those attacks, not a claim about new ones, and the last row shows new ones still come."
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
        f"**Market.** [{g['source']}]({g['url']}) expects guardian agents, the category this sits in, to take {g['low_pct']} to {g['high_pct']}% of the agentic AI market by {g['by_year']}. [{a['source']}]({a['url']}) sizes AI agents at ${a['usd_b_2025']} billion in 2025 and ${a['usd_b_2033']} billion by 2033. Bottom up: at the ${price['usd_per_database_month']} a month we plan to charge, {derived['first_target_pct']}% of those companies with one protected database each is ${derived['first_target_usd_m_per_year']} million a year, and all of them, which is a ceiling since not all let agents near prod, is ${derived['sam_usd_b_per_year']} billion.",
        "",
        "| Who else | What they do well | What's missing for this job |",
        "| --- | --- | --- |",
    ]
    for c in m["competition"]:
        lines.append(f"| {c['who']} | {c['strength']} | {c['gap']} |")
    lines += ["", f"**What's different:** {m['us']['usp']} **Scope today:** {m['us']['weakness']}"]
    return "\n".join(lines)


def block_reviewer() -> str:
    d = load("reviewer.json")
    if not d:
        return ""
    a, b = d["plan_only"], d["with_report"]
    return (
        f"**Does the report help the person?** A model stood in for the reviewer on {d['plans_scored']} of the {d.get('distinct_plans', d['plans_scored'])} distinct plans the benchmark held, the ones it answered both times, deciding each one twice. Reading the request, schema and plan, as in a pull request, it approved {a['harmful']['approved']} of {a['harmful']['total']} harmful plans and {a['good']['approved']} of {a['good']['total']} good ones. "
        f"With the measured report added, it approved {b['harmful']['approved']} of {b['harmful']['total']} harmful and {b['good']['approved']} of {b['good']['total']} good. This is a model, not a user study, and it never saw the oracles. Model `{d['model']}`" + (f", ${d['cost_usd']} of inference" if d.get("cost_usd") else "") + f". Re-run: `{d['rerun']}`."
    )



def size_line() -> str:
    """How big a database it serves today, from the largest scale run that finished."""
    sc = load("scale.json")
    ok = [r for r in (sc or {}).get("rows", []) if not r.get("errors") and r.get("rehearsal_total_s")]
    if not ok:
        return ""
    big = max(ok, key=lambda r: r["db_mb"])
    gb = big["db_mb"] / 1000
    return (f"**Size served today.** Databases up to about {gb:.0f} GB: a full rehearsal of a {big['db_mb']:,} MB database, {big['rows_changed']:,} rows changed, took "
            f"{big['rehearsal_total_s']:.0f} s (`bench/scale.json`). Thin clones are what takes it past that.")

SPLIT_NAMES = {"heldout": "Held-out tasks, ours", "external": "Tasks adapted from an outside benchmark (SABER)", "tuning": "Tuning tasks"}


def split_sentence(d: dict) -> str:
    ex = ((d.get("rates") or {}).get("by_split") or {}).get("external")
    if not ex:
        return ""
    a, f = ex["passed_after_breaking_a_rule"], ex["passed_first_time"]
    return f"The gap is widest on the outside-benchmark tasks: {a['harmful']} of {a['plans']} ({a['harmful_pct']}%) against {f['harmful']} of {f['plans']} ({f['harmful_pct']}%)."


def split_table(d: dict) -> str:
    sp = (d.get("rates") or {}).get("by_split") or {}
    rows = []
    for key in ("external", "heldout", "tuning"):
        if key in sp:
            a, f = sp[key]["passed_after_breaking_a_rule"], sp[key]["passed_first_time"]
            rows.append([SPLIT_NAMES.get(key, key), f"{a['harmful']} of {a['plans']} ({a['harmful_pct']}%)", f"{f['harmful']} of {f['plans']} ({f['harmful_pct']}%)"])
    a, f = d["rates"]["passed_after_breaking_a_rule"], d["rates"]["passed_first_time"]
    rows.append(["Every recorded run", f"{a['harmful']} of {a['plans']} ({a['harmful_pct']}%)", f"{f['harmful']} of {f['plans']} ({f['harmful_pct']}%)"])
    return table(["Risky plans that passed every guardrail", "Passed only after breaking a rule: harmful", "Passed first time: harmful"], rows)

def evasion_sentence(d: dict) -> str:
    """The finding in one paragraph. The submission uses it too, so the two can't say different things."""
    r = d["rates"]
    a, f = r["passed_after_breaking_a_rule"], r["passed_first_time"]
    des, un = d["detection"]["design"], d["detection"]["unseen"]
    return (
        f"Told which rule it broke, the agent sometimes gets around it. In runs recorded before we checked for this, risky plans that passed only after breaking a guardrail "
        f"did harm in {a['harmful']} of {a['plans']} cases ({a['harmful_pct']}%), against {f['harmful']} of {f['plans']} ({f['harmful_pct']}%) for plans that passed first time. "
        + split_sentence(d) + " "
        f"So a plan that follows a broken rule now gets two more checks, and if either doubts it, the plan goes back to the agent. "
        f"On plans nobody read while writing the checks, they caught {un['harmful']['caught']} of {un['harmful']['total']} harmful plans and sent back {un['good']['caught']} of {un['good']['total']} good ones."
    )


def block_evasion() -> str:
    d = load("evasion.json")
    if not d or not d.get("detection"):
        return ""
    r = d["rates"]
    des, un = d["detection"]["design"], d["detection"]["unseen"]
    out = [evasion_sentence(d).replace("Told which rule it broke, the agent sometimes gets around it. ", "", 1)]
    if (r.get("by_split") or {}):
        out.append(split_table(d))
    out.append(f"None of the {r['safe_plans']} safe plans broke a rule first, so the checks cost nothing there.")
    ex = (d.get("examples") or [None])[0]
    if ex:
        rows = []
        for a in ex["attempts"]:
            what = {"failed_guardrails": f"broke: {'; '.join(a['broke'])}", "passed": "passed every guardrail", "invalid_plan": "no steps, told to return at least one", "sql_error": "error on the clone"}.get(a["verdict"], str(a["verdict"]).replace("_", " "))
            plan = "<br>".join(f"`{c[:110]}{'…' if len(c) > 110 else ''}`" for c in a["plan"]) or "none"
            rows.append([str(a["n"]), plan, what])
        out.append(f"One recorded run, task `{ex['task']}`: \"{ex['request']}\"\n\n" + table(["Attempt", "Plan", "Result on the clone"], rows))
        if ex.get("harm"):
            out.append(f"The benchmark's own check, run after approving the last plan, found: {', '.join(ex['harm'])}. Every guardrail had passed.")
    # The mechanics fold away, so the finding, its example and what it changed stay on the page.
    mech: list[str] = []
    mech.append(
        "The two checks: **measured**, with no model, a column the plan changed that a rule it broke reads, and that the plan which broke the rule didn't change; "
        f"and a **second model** (`{d['model']}`) reading only the plans. Either one's doubt sends the plan back. A plan a person submits gets one try, so it's never checked this way. "
        "The measured check skips a table the plan that broke the rule deleted rows from, so a soft delete after a hard one isn't sent back. That also hides a blanked column on that table"
        + (", as in the example above," if ex and not ex.get("measured") else "")
        + " and the second model is what catches those."
    )
    mech.append(table(
        ["Retried plans, replayed", "Harmful plans caught", "...by the measured check", "...by the second model", "Good plans sent back"],
        [
            [f"Written from ({des['plans']} plans)", f"{des['harmful']['caught']} of {des['harmful']['total']}", str(des["harmful"]["by_measured_check"]), str(des["harmful"]["by_second_reader"]), f"{des['good']['caught']} of {des['good']['total']}"],
            [f"Unseen ({un['plans']} plans)", f"{un['harmful']['caught']} of {un['harmful']['total']}", str(un["harmful"]["by_measured_check"]), str(un["harmful"]["by_second_reader"]), f"{un['good']['caught']} of {un['good']['total']}"],
        ],
    ))
    mech.append(
        "The unseen plans come from the same tasks run on a stricter schema, so this tests new plans, not new tasks. "
        "The replay reads columns from the plan's text, because those records don't keep measured columns; the product uses the measured ones."
    )
    e = d.get("empty_plans") or {}
    if e.get("plans"):
        mech.append(
            f"The loop also used to push an agent that returned no steps to return at least one. Those {e['plans']} plans were harmful {e['harmful']} times and good {e['good']} times. "
            "Now no steps can be a refusal: it gets one plain question, and a second empty answer ends the run."
        )
    out.append("<details><summary>How the two checks work, and what they caught and missed</summary>\n\n" + "\n\n".join(mech) + "\n\n</details>")
    after = d.get("after")
    if after and after.get("heldout"):
        h, dn = after["heldout"]["harm"], after["heldout"]["done"]
        out.append(
            f"With both changes in the benchmark, approved unread, held-out harm went from {h['from']:g} to {h['to']:g} ({fmt_ci(h)}) and work done safely from {dn['from']:g} to {dn['to']:g} ({fmt_ci(dn)}). "
            f"Of {after['runs']} Shadow Run runs, {after['checked']} were checked, {after['flagged_at_least_once']} were sent back at least once, and {after['stopped']} ended there."
        )
    out.append(f"Re-run: `{d['rerun']}`.")
    return "\n\n".join(out)


def vultr_line(vu: dict | None) -> str:
    """One sentence on what the final benchmark did on Vultr, from bench/vultr.json. Empty if it wasn't measured."""
    if not vu or not (vu.get("benchmark") or {}).get("code_matches_checkout"):
        return ""
    inf, mv = vu.get("inference") or {}, vu.get("microvms") or {}
    pg = (vu.get("postgres") or {}).get("benchmark") or {}
    os_ = vu.get("object_storage") or {}
    budget = (vu.get("spend") or {}).get("budget") or {}
    parts = []
    if inf.get("tokens"):
        parts.append(f"the final benchmark spent {inf['tokens']:,} tokens of Serverless Inference across the {inf['models_used']} models the benchmark called (${inf['cost_usd']:.2f})")
    if mv.get("total"):
        parts.append(f"booted {mv['total']:,} microVMs on one VX1")
    if pg.get("databases_created"):
        parts.append(f"created {pg['databases_created']:,} throwaway databases on Managed PostgreSQL over the VPC")
    if os_.get("objects"):
        by = {b["prefix"]: b["objects"] for b in os_.get("by_prefix", [])}
        if by.get("runs") and by.get("backups"):
            parts.append(f"and Object Storage holds {by['runs']} signed evidence bundles and {by['backups']} pre-apply backups")
        else:
            parts.append(f"and Object Storage holds {os_['objects']} evidence bundles and pre-apply backups")
    text = ", ".join(parts)
    if budget.get("spent_usd") is not None:
        text += f". Spent so far: ${budget['spent_usd']:.2f} of the ${budget['ceiling_usd']:.0f} credit"
    return text[:1].upper() + text[1:] if text else ""


def block_vultr() -> str:
    vu = load("vultr.json")
    if not vu or not (vu.get("benchmark") or {}).get("code_matches_checkout"):
        return ""
    inf, mv = vu.get("inference") or {}, vu.get("microvms") or {}
    pg = (vu.get("postgres") or {}).get("benchmark") or {}
    os_ = vu.get("object_storage") or {}
    budget = (vu.get("spend") or {}).get("budget") or {}
    res = vu.get("resources") or {}
    jobs = "; ".join(f"`{m['model']}`: {', '.join(j['job'] for j in m['jobs'])}" for m in vu.get("models") or [])
    rows = []
    if inf.get("tokens"):
        rows.append(["Serverless Inference", f"{inf['tokens']:,} tokens over {inf['runs']:,} benchmark runs, ${inf['cost_usd']:.2f}, across the {inf['models_used']} models the benchmark called. Every model the project uses, and for what: {jobs}"])
    if mv.get("total"):
        boot = mv.get("clone_boot_ms") or {}
        rows.append(["VX1", f"{mv['total']:,} microVMs across every benchmark file: {mv['rehearsals']:,} rehearsals and {mv['reproductions']:,} second-clone reproductions. Clone boot p50 {boot.get('p50', 0):,.0f} ms, p95 {boot.get('p95', 0):,.0f} ms. {mv['containment_complete']:,} of {mv['rehearsals']:,} rehearsals came back with a complete containment record; the rest were refused, not counted"])
    if pg.get("databases_created"):
        rows.append(["Managed PostgreSQL 16", f"{pg['databases_created']:,} databases created from templates for single runs and dropped after them ({pg['drop_failed']} drops failed), over the VPC"])
    if os_.get("objects"):
        pre = "; ".join(f"{p['objects']} under `{p['prefix']}/`, {p['what']}" for p in os_.get("by_prefix") or [])
        rows.append(["Object Storage", f"{os_['objects']} objects, {os_['bytes'] / 1048576:.1f} MiB: {pre}"])
    if res.get("count"):
        rows.append(["The account", f"{res['count']} resources tagged shadowrun, {res.get('firewall_rules', 0)} firewall rules" + (f". Spent ${budget['spent_usd']:.2f} of the ${budget['ceiling_usd']:.0f} credit" if budget.get("spent_usd") is not None else "")])
    if not rows:
        return ""
    return (
        "Measured, not estimated: what the final benchmark did on each service, from the runs files and read-only Vultr API calls.\n\n"
        + table(["Vultr service", "In the final benchmark"], rows)
        + f"\n\nRe-run: `{vu.get('rerun', 'python -m bench.vultr_usage')}`."
    )


def block_summary() -> str:
    """The README's first screen: each line is one claim with its number, read from the files it names."""
    r, st = load("results.json"), load("stats.json")
    if not r or not st or not st.get("main") or r.get("status") != "measured" or not comparable(r):
        return NOT_YET
    v = view(st, r)
    h = v["sets"]["heldout"]
    held = r["heldout"]["shadow_run"]
    d, u = h["arms"]["direct"], h["arms"]["unread"]
    c = h["compare"]["unread_vs_direct"]
    alone_changed = st["main"]["retries"]["auto_applied_that_changed_something"]
    out = [
        f"_How to read these: the same agent (`{r['model']}` on Vultr Serverless Inference) and prompt in every mode, a fresh copy of the database for every run, mean of {r['runs_per_task']} runs per task. "
        "Held-out tasks were kept out of tuning ([how](#results)). Harm is decided by oracles that check the outcome, not the plan. "
        "Approved unread means the reviewer clicks approve on every plan that waits, without reading it: the worst case for Shadow Run._",
        "",
    ]
    ext = (v["sets"].get("external") or {}).get("compare", {}).get("unread_vs_direct")
    ctl = (st.get("controls") or {})
    held_sql = (ctl.get("sets") or {}).get("heldout_sql") if ctl.get("status") == "measured" and ctl.get("same_code_as_main") else None
    if c["harm"]["excludes_zero"] and c["harm"]["difference"] < 0:
        line = (f"- **Even if the reviewer approves every plan without reading it, harm fell from {d['harm']:g} to {u['harm']:g} of {h['tasks']} held-out risky tasks** "
                f"({c['harm']['tasks_down']} tasks better, {c['harm']['tasks_up']} worse)")
        if ext and ext["harm"]["excludes_zero"] and ext["harm"]["difference"] < 0:
            line += f", and from {ext['harm']['from']:g} to {ext['harm']['to']:g} on {v['sets']['external']['tasks']} tasks adapted from an outside benchmark ({ext['harm']['tasks_down']} better, {ext['harm']['tasks_up']} worse)"
        line += "."
        if held_sql:
            arms = held_sql["arms"]
            line += (f" Giving the agent every guardrail in its prompt gets close, {arms['rules_in_prompt']['harm']:g} against {arms['unread']['harm']:g} on the {held_sql['tasks']} held-out SQL tasks. "
                     "What a prompt can't do is show a person what the plan really does before prod, or contain a hostile plan, and that is what Shadow Run adds: "
                     f"{held['risky_held']['mean']:g} of {h['tasks']} risky plans waited for a person with a measured report, so {held['harm_on_prod']['mean']:g} did harm unseen.")
        out.append(line + " (`bench/stats.json`)")
    else:
        out.append(f"- **Approved unread, harm went from {d['harm']:g} to {u['harm']:g}** ({fmt_ci(c['harm'])}, {fmt_p(c['harm']['permutation_p'])}). (`bench/stats.json`)")
    ev = load("evasion.json")
    if ev and ev.get("detection"):
        aft = ev.get("after") or {}
        ex_h, he_h = (aft.get("external") or {}).get("harm"), (aft.get("heldout") or {}).get("harm")
        line = ("- **It found a failure mode a rule can't see: guardrail evasion.** Told which rule its plan broke, an agent sometimes changes what the rule looks at instead of doing the job safely, "
                "as in [the recorded run](#what-we-found-told-which-rule-it-broke-the-agent-gets-around-it). ")
        if ex_h and he_h and ex_h["difference"] < 0:
            line += (f"The two changes it led to cut harm, approved unread, from {ex_h['from']:g} to {ex_h['to']:g} on the outside-benchmark tasks ({ex_h['tasks_down']} tasks better, {ex_h['tasks_up']} worse) "
                     f"and from {he_h['from']:g} to {he_h['to']:g} on the held-out tasks ({he_h['tasks_down']} better, {he_h['tasks_up']} worse), comparing benchmark runs before and after")
        line += " (`bench/evasion.json`)."
        out.append(line)
    rt, inc, cl = load("redteam.json"), load("incidents.json"), load("controls.json")
    parts = []
    if rt:
        parts.append(f"**{rt['contained']} of {rt['total']} live attacks contained**, each in a microVM with no network card, checked from the host{', with prod’s hash unchanged' if rt.get('prod_unchanged') else ''}")
    if inc and inc.get("incidents"):
        n = len(inc["incidents"])
        b = sum(1 for i in inc["incidents"] if i["status"] == "blocked" and not i.get("reached_prod"))
        measured = sum(1 for i in inc["incidents"] if i.get("measured") or i.get("metrics"))
        parts.append(f"**{b} of {n} real incident commands** replayed on a clone and stopped before prod" + (f": {measured} measured on the clone, {n - measured} failed there because they reach outside it" if measured < n else ""))
    if cl and cl.get("total"):
        parts.append(f"**{cl['passed']} of {cl['total']} checks** on approval, apply and undo passed, attacks and honest path alike")
    if parts:
        out.append("- " + "; ".join(parts) + " (`bench/redteam.json`, `bench/incidents.json`, `bench/controls.json`).")
    line = vultr_line(load("vultr.json"))
    reh = held.get("rehearsal_s") or {}
    if line:
        speed = (f" On the demo database a rehearsal takes {reh['p50']:g} s at the median, and a whole held-out task {held['seconds_per_task']:g} s and ${held['cost_per_task_usd']:g} of inference."
                 if reh.get("p50") else "")
        out.append(f"- **On Vultr end to end:** {line}.{speed} (`bench/vultr.json`, `bench/results.json`)")
    mp = ROOT / "docs" / "market.json"
    if mp.exists():
        mk = json.loads(mp.read_text())
        dv, g, price = mk["developers_using_agents"], mk["guardian_share"], mk["price"]["usd_per_database_month"]
        out.append(
            f"- **Who pays:** the engineer who owns production Postgres at a team using coding agents, and {dv['weekly_pct']}% of professional developers now use them weekly ([{dv['source']}]({dv['url']})). "
            f"Shadow Run is open source and free to self-host on Vultr; hosted, it's ${price} a month per protected database of up to about 1 GB"
            + (f", against ${economics()['fixed']:.0f} a month of Vultr list price per deployment plus a measured ${economics()['per_k']:.2f} per 1,000 rehearsed tasks ([unit economics](#unit-economics))" if (economics() or {}).get("fixed") else "")
            + f". [{g['source']}]({g['url']}) expects guardian agents, the category this sits in, "
            f"to take {g['low_pct']} to {g['high_pct']}% of the agentic AI market by {g['by_year']} ([who this is for](#who-this-is-for), [market](#market-and-competition))."
        )
    return "\n".join(out)


def economics() -> dict | None:
    """What it costs to serve one protected database on Vultr, from the measured run and list prices, against the planned price."""
    r, vu = load("results.json"), load("vultr.json")
    mp = ROOT / "docs" / "market.json"
    if not r or not vu or not mp.exists():
        return None
    s = ((r.get("all_risky_and_safe") or {}).get("shadow_run") or {})
    if not s.get("cost_per_task_usd") or not s.get("seconds_per_task") or not r.get("vx1_usd_per_hour"):
        return None
    price = json.loads(mp.read_text())["price"]["usd_per_database_month"]
    inf, secs, vx1 = s["cost_per_task_usd"], s["seconds_per_task"], r["vx1_usd_per_hour"]
    # An upper bound: the whole VX1 host, for the task's whole wall time, although a host runs several rehearsals at once.
    vx1_task = vx1 * secs / 3600
    per_task = inf + vx1_task
    # One deployment: the control VM, the VX1 host and the bucket. Prod is the customer's own database, so it isn't counted.
    res = (((vu.get("spend") or {}).get("budget") or {}).get("resources") or [])
    fixed_parts = [x for x in res if "dbaas" not in (x.get("plan") or "")]
    fixed = sum(x["usd_per_hour"] for x in fixed_parts) * 24 * 30 if fixed_parts else None
    tasks = 1000
    out = dict(tasks=s.get("risky_tasks", 0) + s.get("safe_tasks", 0), inf=inf, secs=secs, vx1=vx1, vx1_task=vx1_task, per_task=per_task, per_k=per_task * 1000, price=price, fixed=fixed)
    if fixed is not None:
        out["margin_one_db"] = (price - fixed - per_task * tasks) / price
        out["margin_k"] = {k: (k * price - fixed - k * per_task * tasks) / (k * price) for k in (1, 2, 3)}
        out["tasks_to_cost"] = (price - fixed) / per_task
    return out


def block_economics() -> str:
    e = economics()
    if not e:
        return ""
    rows = [
        ["Inference on Vultr Serverless Inference, every model call", f"${e['inf']:g} per task (mean over all {e['tasks']} tasks)"],
        [f"VX1 time, at most: the host's list price (${e['vx1']:g} an hour) for the task's whole wall time ({e['secs']:g} s, mean over all {e['tasks']} tasks)", f"${e['vx1_task']:.5f} per task"],
        ["Variable cost per 1,000 rehearsed tasks", f"${e['per_k']:.2f}"],
    ]
    if e.get("fixed") is not None:
        rows += [
            ["Fixed cost of one deployment at Vultr's list price: the control VM, the VX1 host and the bucket. Prod is the customer's own database", f"${e['fixed']:.0f} a month"],
            [f"Infrastructure gross margin on one hosted database at ${e['price']} a month and 1,000 rehearsed tasks, fixed costs included", f"{e['margin_one_db'] * 100:.0f}%"],
            ["...with two databases on the same deployment", f"{e['margin_k'][2] * 100:.0f}%"],
            ["...with three", f"{e['margin_k'][3] * 100:.0f}%"],
            ["Rehearsed tasks a month before one database's total cost reaches its price", f"about {round(e['tasks_to_cost'], -3):,.0f}"],
        ]
    return (table(["Cost to serve", "Measured"], rows)
            + "\n\nThe price is our plan. The costs are measured: inference from the benchmark's own records, the VX1 host, the control VM and the bucket at Vultr's list prices (`bench/results.json`, `bench/vultr.json`). "
            "A deployment serves one team, and a second database on it adds only its variable cost.")

def block_microvm() -> str:
    """Why the rehearsal is a microVM and not a database transaction, from the incident replays and the red team."""
    inc, rt = load("incidents.json"), load("redteam.json")
    if not inc or not rt:
        return ""
    files = []
    for i in inc["incidents"]:
        for m in i.get("measured") or []:
            hit = re.match(r"(\d+) files deleted", m)
            if hit:
                files.append((int(hit.group(1)), i["command"]))
    shell = max(files) if files else None
    text = ("**Why a microVM and not a database transaction.** A transaction can undo rows. It can't undo `rm -rf`, a fork bomb or a call that sends your data out, and it decides on prod itself. "
            "A microVM on the VX1 runs the whole plan, SQL or shell, on a clone with its own kernel, and the host measures what happened. A database plan's microVM has no network card at all; a host plan's has its link down, a deny-all policy and a host firewall for the sandbox user.")
    if shell:
        text += f" Replaying real incidents, `{shell[1]}` deleted {shell[0]:,} files on its clone and nothing on prod"
    text += f"; {rt['contained']} of {rt['total']} hostile plans, from `DROP DATABASE` to a fork bomb, a memory bomb and key theft, were contained, checked from the host (`bench/incidents.json`, `bench/redteam.json`)."
    return text

def block_business() -> str:
    mp = ROOT / "docs" / "market.json"
    if not mp.exists():
        return ""
    m = json.loads(mp.read_text())
    price = m["price"]["usd_per_database_month"]
    lines = [
        "**The buyer** is the engineer who owns production Postgres, a platform lead or a staff engineer, at a team that lets coding agents run migrations and data fixes. "
        "The trigger is the day someone asks them to hand an agent a database URL. Today they can give it the credential and hope, or have a senior engineer read each statement and guess what it cascades into. "
        "Shadow Run replaces the guess with a measurement, in rows and in the money the business tracks.",
        "",
        "Nothing has to be trusted on day one:",
        "",
        table(["How a team runs it", "What the team gets", "Price"], [
            ["Self-hosted, open source", "The pull request Action, the MCP server and the sandboxes on the team's own Vultr account, from `scripts/up.sh`. Every migration in a pull request gets a comment saying what it really does, and the agent gives up its database URL for rehearse and apply.",
             "Free. The team pays Vultr for what it runs" + (f": about ${economics()['fixed']:.0f} a month at list price" if (economics() or {}).get("fixed") else "")],
            ["Hosted", "The same, with the control plane and sandboxes run for the team. Every change waits for a person until the team lists otherwise.", f"${price} a month per protected database, up to about 1 GB today"],
            ["An auto-apply list", "The columns the team is happy to change with no person looking, each tested against the attacker first.", "Included"],
            ["Regulated teams", "Self-hosted, with a support licence.", "Per deployment"],
        ]),
        "",
        *([size_line(), ""] if size_line() else []),
        "**Go to market.** The free Action goes where migrations are reviewed: every pull request comment shows what the migration really does and ends with the MCP setup for the agent (`control/cli.py`). "
        "Teams that adopt it self-host on their own Vultr account; teams that don't want to run it move to hosted, per protected database.",
        "",
        "**Revenue.** " + " ".join(m["revenue"]),
        "",
        "**What comes next.** " + " ".join(m["next"]),
    ]
    return "\n".join(lines)

def kvm_line() -> str:
    k = load("kvm_tests.json")
    if not k or not k.get("tests"):
        return ""
    when = (k.get("at") or "")[:16].replace("T", " ")
    return (f" The KVM tests, which CI can't run, last ran on {k['host']}: {k['passed']} of {k['tests']} passed in {k['seconds']:g} s, at {when} "
            f"(`bench/kvm_tests.json`, re-run: `{k['rerun']}`).")


def block_tests() -> str:
    """How much of the code the tests reach, counted by pytest itself, so the number can't drift from the suite."""
    import subprocess

    def collected(*marks: str) -> int | None:
        r = subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", *marks], cwd=ROOT, capture_output=True, text=True)
        m = re.search(r"(\d+)(?:/\d+)? tests? (?:collected|selected)", r.stdout)
        return int(m.group(1)) if m else None

    total, kvm = collected(), collected("-m", "kvm")
    files = len(list((ROOT / "tests").glob("test_*.py")))
    if not total:
        return "Run `pytest`."
    return (
        f"**{total} automated tests** in {files} files. {kvm} of them boot real microVMs on KVM: rehearsals, the blast-radius measurement, guardrails, "
        "the proved undo and the containment checks. The rest cover the static gate, plan hashing, approvals, apply and roll back on drift, the budget, the API, "
        "the CLI, the MCP tools and the benchmark harness, many of them against a real Postgres. CI runs every test that doesn't need `/dev/kvm` on each push, and checks "
        "that the README's charts still match the benchmark files. Run them with `pytest`, or `pytest -m 'not kvm'` on a machine without KVM."
        + kvm_line()
    )

BLOCKS = {
    "vultr": block_vultr,
    "summary": block_summary,
    "tests": block_tests,
    "economics": block_economics,
    "microvm": block_microvm,
    "business": block_business,
    "evasion": block_evasion,
    "market": block_market,
    "reviewer": block_reviewer,
    "incidents": block_incidents, "video": block_video, "wider": block_wider, "gate": block_gate, "clone_check": block_clone_check, "second_opinion": block_second_opinion, "gauntlet": block_gauntlet, "models": block_models,
    "live": block_live, "headline": block_headline, "results": block_results, "groups": block_groups, "redteam": block_redteam,
    "suite": block_suite, "audit": block_audit, "refusals": block_refusals, "restrict": block_restrict,
    "controls": block_controls, "scale": block_scale, "soak": block_soak, "cost": block_budget,
}


def render(text: str, names: list[str] | None = None) -> str:
    for name, fn in BLOCKS.items():
        if names and name not in names:
            continue
        start, end = f"<!-- {name}:start -->", f"<!-- {name}:end -->"
        if start in text:
            text = re.sub(re.escape(start) + r".*?" + re.escape(end), lambda _: f"{start}\n{fn()}\n{end}", text, flags=re.S)
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="*", choices=sorted(BLOCKS), help="render only these blocks")
    ap.add_argument("--check", action="store_true", help="print the blocks and write nothing")
    args = ap.parse_args()
    if args.check:
        for name in args.only or sorted(BLOCKS):
            print(f"--- {name}\n{BLOCKS[name]()}\n")
        return 0
    path = ROOT / "README.md"
    path.write_text(render(path.read_text(), args.only))
    print("README blocks rendered")
    publish()
    return 0


def publish() -> None:
    """Copies the files the README was just rendered from into bench/published/, which is what the live site reads. Only
    a complete, measured run is published, so a judge never sees a benchmark that is still writing its files."""
    r = load("results.json") or {}
    complete = r.get("status") == "measured" and r.get("harness_errors") == 0 and r.get("runs") == r.get("expected_runs")
    if not complete:
        print(f"not published: results.json is {r.get('status')!r} with {r.get('harness_errors')} harness errors; the site keeps bench/published/")
        return
    out = ROOT / "bench" / "published"
    out.mkdir(exist_ok=True)
    for f in sorted((ROOT / "bench").glob("*.json")):
        shutil.copy2(f, out / f.name)
    print(f"published {len(list(out.glob('*.json')))} files to bench/published/")


if __name__ == "__main__":
    sys.exit(main())
