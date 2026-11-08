#!/usr/bin/env python3
"""Write docs/SUBMISSION.md, the text for the lablab form. Measured numbers come from bench/*.json."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from checker.control_kinds import control_kind  # noqa: E402
from make_readme_table import block_summary, evasion_sentence, basis_sentence, concentration_sentence, hold_sentence, lead_sentence, rehearsing_text, saber_sentence, task_level_sentence, view  # noqa: E402


# The form's short description takes 50 to 255 characters, so it says what it is, not how.
SHORT = (
    "Your agent wants to touch prod. Shadow Run lets it break a clone first: every risky plan runs on a full clone "
    "in a microVM on Vultr, Postgres measures the blast radius, and a person approves the exact plan before it reaches prod."
)


def load(name: str) -> dict | None:
    p = ROOT / "bench" / name
    return json.loads(p.read_text()) if p.exists() else None


def form_text(r: dict, st: dict, rt: dict, ev: dict | None, ai: dict, url: str) -> str:
    """The lablab field takes 600 to 2,000 characters. Every number comes from the same files as the rest."""
    from make_readme_table import fmt_p
    v = view(st, r)
    h = v["sets"]["heldout"]
    d, u = h["arms"]["direct"], h["arms"]["unread"]
    c = h["compare"]["unread_vs_direct"]
    held = r["heldout"]["shadow_run"]
    parts = []
    if ai:
        parts.append(f"In October 2026, {ai['unexpected_or_unauthorized_pct']}% of professionals {ai['source'].split(',')[0]} surveyed had confirmed or suspected an AI agent acting unexpectedly or without authorization; only {ai['can_stop_automatically_pct']}% could stop one automatically.")
    parts.append(
        "Shadow Run authorizes what a plan does, not what it says. The agent gets no credential. Every risky SQL or shell plan it writes is frozen, hashed and run first on a full clone of prod in a throwaway microVM on a Vultr VX1, cut off from the network. "
        "Postgres measures the blast radius, frozen guardrails decide, and a different person approves those exact hashes before the same plan runs on prod in one transaction that rolls back on any surprise. Its undo, when one exists, is proved on the clone first."
    )
    tested = f" ({fmt_p(c['harm']['permutation_p'])} over tasks)" if c["harm"]["excludes_zero"] else ""
    kept = f", and tasks finished safely held up ({u['done']:g} against {d['done']:g})" if u["done"] >= d["done"] else ""
    parts.append(f"On {h['tasks']} held-out risky tasks, {held['harm_on_prod']['mean']:g} did harm before a person saw the plan, against {d['harm']:g} for the agent alone. Even with every plan approved unread, harm fell from {d['harm']:g} to {u['harm']:g}{tested}{kept}.")
    if ev and ev.get("detection"):
        a, f_ = ev["rates"]["passed_after_breaking_a_rule"], ev["rates"]["passed_first_time"]
        un = ev["detection"]["unseen"]["harmful"]
        parts.append(f"We found that an agent told which rule it broke can get around it: those plans were harmful {a['harmful_pct']}% of the time, against {f_['harmful_pct']}%. Shadow Run now screens every such plan twice, by measurement and by a second model.")
    inc = load("incidents.json") or {}
    vu = load("vultr.json") or {}
    if rt:
        blocked = sum(1 for i in inc.get("incidents", []) if i["status"] == "blocked" and not i.get("reached_prod"))
        replayed = f", and {blocked} of {len(inc['incidents'])} real incident commands replayed on a clone were blocked" if inc.get("incidents") else ""
        used = (f" The benchmark ran {vu['microvms']['total']:,} microVMs on a VX1 and {vu['inference']['tokens'] / 1e6:.2f} million tokens of Vultr Serverless Inference, with prod on Vultr Managed PostgreSQL and evidence in Vultr Object Storage."
                if vu.get("microvms") and vu.get("inference") else " Every rehearsal runs on a VX1, prod on Vultr Managed PostgreSQL, evidence in Vultr Object Storage.")
        parts.append(f"{rt['contained']} of {rt['total']} live attacks contained{replayed}. Every model call Shadow Run makes goes to Vultr Serverless Inference.{used}")
    mk = json.loads((ROOT / "docs" / "market.json").read_text())
    price = (mk.get("price") or {}).get("usd_per_database_month")
    from make_readme_table import economics
    econ_f = economics()
    parts.append(
        f"Who pays: the database owner at a team using coding agents, which {mk['developers_using_agents']['weekly_pct']}% of professional developers now use weekly ({mk['developers_using_agents']['source'].split(' Developer')[0]}). "
        "It plugs into any agent over MCP, a CLI or a GitHub Action that posts what a migration really does on the pull request."
        + (f" It starts free as that Action, then ${price} a month per protected database." if price else "")
        + (f" Measured cost to serve: ${econ_f['fixed']:.0f} a month per deployment plus ${econ_f['per_k']:.2f} per 1,000 rehearsed tasks, a {econ_f['margin_one_db'] * 100:.0f}% margin on one database." if econ_f and econ_f.get("fixed") else "")
    )
    parts.append(f"Race the agent yourself: {url}/race")
    text = "\n\n".join(parts)
    if len(text) > 2000:
        print(f"the form text is {len(text)} characters, over 2,000", file=sys.stderr)
    return text


def main() -> int:
    state = json.loads((ROOT / "infra/STATE.json").read_text())
    url = state.get("public_url", "URL")
    r = load("results.json") or {}
    rt = load("redteam.json") or {}
    c = load("controls.json") or {}
    st = load("stats.json") or {}
    ev = load("evasion.json")
    evasion = evasion_sentence(ev) if ev and ev.get("detection") else ""
    measured = r.get("status") == "measured" and r.get("scope") == "full" and st.get("main")
    if measured:
        s = r["heldout"]["shadow_run"]
        v = view(st, r)
        lead = lead_sentence(v).replace("**", "")
        # The sentences come from the README generator, so the two can't say different things.
        headline = f"{lead} {basis_sentence(v)}{task_level_sentence(v)} {concentration_sentence(v)} {rehearsing_text(st, v).split(chr(10) * 2)[-1]} {hold_sentence(st, r)}"
        external = saber_sentence(v)
        timing = (
            f"A rehearsal takes {s['rehearsal_s']['p50']} s at the median, and a task costs ${s['cost_per_task_usd']} in inference."
        )
    else:
        headline = "(Fill in after the final benchmark: run scripts/make_submission.py again.)"
        external = timing = ""
    containment = f"{rt.get('contained', '?')} of {rt.get('total', '?')} red-team attacks contained, checked from the host, with prod's hash unchanged." if rt else ""
    def plain(t: str) -> str:
        t = re.sub(r"^_How to read these:.*?_\n\n", "", t, flags=re.S | re.M)
        t = re.sub(r" ?\((?:\[[^\]]+\]\(#[^)]+\)(?:, )?)+\)", "", t)
        t = re.sub(r"\[([^\]]+)\]\(#[^)]+\),? ?", "", t)
        t = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", t)
        return t.replace("**", "").replace("`", "")
    summary = plain(block_summary()) if measured else ""
    vu = load("vultr.json") or {}
    vultr_measured = f" {plain(vu['headline'])}" if vu.get("headline") else ""
    soak = load("soak.json") or {}
    soak_line = f" {soak.get('rehearsals')} rehearsals in a row left no sandbox behind." if soak.get("all_contained") and soak.get("rehearsals") else ""
    brief = (
        "AI agents with real access keep destroying production data with one command. Shadow Run sits between an agent and prod and holds the only credential. "
        "Every risky plan is frozen, hashed and run on a full clone of prod in a fresh Microsandbox microVM on Vultr, with no network device and no secrets. Postgres reports what really happened, frozen guardrails check it, and failures go back to the agent to rewrite the plan. "
        "A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal.\n\n"
        + (f"{summary}\n\n" if measured else "")
        + "Every LLM call goes to Vultr Serverless Inference, on VX1, Cloud Compute, Managed PostgreSQL, Object Storage and a VPC. It ships as a web app, an MCP server, a CLI and a GitHub Action."
    )
    mk = json.loads((ROOT / "docs" / "market.json").read_text())
    ai = mk.get("agent_incidents") or {}
    form = form_text(r, st, rt, load("evasion.json"), ai, url) if measured else "(Fill in after the final benchmark.)"
    incidents = (
        f"In October 2026, {ai['unexpected_or_unauthorized_pct']}% of the security and technology professionals {ai['source'].split(',')[0]} surveyed had confirmed or suspected an AI agent acting unexpectedly or without authorization; more than {ai['of_those_modified_or_deleted_data_pct_over']}% of those had seen agents modify or delete data, and only {ai['can_stop_automatically_pct']}% could automatically stop an agent in production. "
        if ai else ""
    )
    from make_readme_table import economics
    econ = economics()
    market = (
        f"Who pays: whoever owns the database at a team using coding agents. {mk['developers_using_agents']['weekly_pct']}% of professional developers now use them weekly ({mk['developers_using_agents']['source']}). "
        f"It starts free, as a pull request Action that can't touch prod, and then a subscription per protected database, with a self-hosted licence for regulated teams. "
        + (f"Measured cost to serve: ${econ['fixed']:.0f} a month per deployment plus ${econ['per_k']:.2f} per 1,000 rehearsed tasks, inference and VX1 time included, a {econ['margin_one_db'] * 100:.0f}% margin on one database at ${econ['price']} a month. " if econ and econ.get("fixed") else "")
        + 
        f"Gartner expects guardian agents to take {mk['guardian_share']['low_pct']} to {mk['guardian_share']['high_pct']}% of the agentic AI market by {mk['guardian_share']['by_year']}. "
        f"Migration linters read the statement, and thin clones like DBLab and Neon give a copy. What's different: {mk['us']['usp'].replace(' None of the docs above describe that.', '')} "
        f"Scope today: {mk['us']['weakness'][0].lower()}{mk['us']['weakness'][1:]}"
    )
    gt = load("gauntlet.json") or {}
    attack = ""
    if gt.get("baseline_summary"):
        base, now, replay = gt["baseline_summary"], gt["first_summary"], gt["replay"]
        attack = (
            f"We attacked our own policy. An attacker model told every guardrail and the auto-apply rule got {base['would_auto_apply']} of {base['real_attacks']} damaging plans past a row limit, with no person looking, "
            f"so auto-apply now works from a named list. {now['would_auto_apply']} of the same attacker's {now['real_attacks']} damaging plans would still apply alone, but they can only change what the owner listed: {', '.join(now.get('reach_alone', [])) or 'nothing'}. What it finds becomes a candidate rule, which counts only if it holds on the clean database, fails on the attack and lets ordinary changes through. "
            f"Replayed against the rules they taught, {replay['caught']} of {replay['total']} of those attacks are now stopped, in a separate test with {replay['guardrails']} rules."
        )
    kinds = [control_kind(x["control"]) for x in c.get("controls", [])]
    controls = f"{kinds.count('attack')} attacks on the approval, the apply and the measurement were refused, rolled back or held, and {kinds.count('honest path')} checks confirm the honest path still works." if c and c.get("passed") == c.get("total") else ""

    assert 50 <= len(SHORT) <= 255, f"the short description is {len(SHORT)} characters; the form takes 50 to 255"
    text = f"""# Lablab submission

Written for: lablab.ai judges and the entry form. Paste each section into its field.

## Title

Shadow Run

## Short description ({len(SHORT)} characters; the form takes 50 to 255)

{SHORT}

## Long description, for the form ({len(form)} characters; the form takes 600 to 2,000)

{form}

## Long description, full

For the README, a blog post or anywhere without a limit.

**The problem.** {incidents}AI agents with real access keep destroying production data with one command. In April 2026 a coding agent at PocketOS deleted a production volume and its backups in nine seconds, by its founder's account. In February, a `terraform destroy` took down DataTalks.Club for about a day. Keeping dev and prod apart didn't help: the agent found a credential that reached prod, and the damage hid in side effects nobody had listed.

**What Shadow Run does.** Don't authorize the command; authorize its measured effect. Allowlists, linters and rules in a prompt judge what a command says. Shadow Run judges what it does, on a real copy of the data, before it can touch the original. It sits between an agent and production and holds the only credential. Every risky SQL or shell plan is frozen and hashed, read by a static gate, and run on a full clone of prod inside a fresh microVM on a Vultr VX1, with no network card and no secrets. Postgres itself reports what happened: rows per table, every foreign-key cascade traced to the step that caused it, and what it does to the numbers a business watches, in dollars. Frozen business guardrails run in the same transaction, and a failure goes back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal. A plan's undo, when one exists, is proved on the clone before anyone approves.

**What we measured.** Same agent, same prompt, a fresh copy of the database for every run, 3 runs per task:

{summary}

{timing} The limits are published with the numbers: side effects outside the target can't be rehearsed, some harm needs a person to notice, and clone cost grows with database size.

**What we found.** {evasion}

**Containment, checked from outside the sandbox.** {containment} {controls}{soak_line}

**We attacked our own policy.** {attack.replace('We attacked our own policy. ', '', 1)}

**Built on Vultr, end to end.** Every LLM call goes to Vultr Serverless Inference, and the models never grade themselves: they propose plans, draft guardrails, explain results and read plans a second time, while Postgres measures and frozen checks decide. The microVMs run on a Vultr VX1, the control plane on Vultr Cloud Compute, prod is Vultr Managed PostgreSQL, evidence bundles and backups go to Vultr Object Storage, and the runner sits on a Vultr VPC behind a firewall group. One script creates all of it from zero and one removes it.{vultr_measured}

**Who pays.** {market.replace('Who pays: whoever', 'Whoever', 1)}

**Try it.** {url}: press Race the agent to watch the same task run alone and through Shadow Run, side by side, or Continue as guest to request, approve, break and undo a change yourself. It also ships as an MCP server (shown with OpenCode on Vultr inference), a CLI and a GitHub Action that posts what a migration really does on the pull request.

## Long description, shorter

Use this one if the form's limit is lower than the version above.

{brief}

## Tags

Vultr, Vultr Serverless Inference, Vultr VX1, Vultr Managed PostgreSQL, Vultr Object Storage, AI agents, agentic AI, AI safety, MCP, microVM, KVM, sandbox, PostgreSQL, database migrations, DevOps, guardrails, human in the loop, Python, FastAPI, React, Qwen, GLM

## Category

Challenge 1: Blast Radius Zero

## Links

Application URL: {url}

GitHub: https://github.com/Prashant-thakur77/Shadow-Run

Demo platform: Vultr (Cloud Compute for the app, VX1 for the sandboxes)

Video presentation (MP4): upload `video/final.mp4`

Slide presentation (PDF): upload `docs/slides.pdf`

Cover image (16:9): upload `docs/cover.png`

## Vultr Community post (optional, after submitting)

Shadow Run: let your agent break a clone of prod before it touches the real one.

Every LLM call goes to Vultr Serverless Inference. Each rehearsal is a throwaway microVM on a VX1 instance, with no network device, on a clone of a Managed PostgreSQL database, with evidence in Object Storage and the runner behind a VPC. One script creates all of it and one removes it.

We also attacked our own auto-apply policy with a Vultr-hosted model, and published what it found.

Try it at {url}, code at https://github.com/Prashant-thakur77/Shadow-Run.

## Use case and how the agent executes real tasks

A team lets a coding agent run migrations and data cleanups. Today that means giving it a database URL. With Shadow Run the agent gets no credential, and the plan it writes runs for real on a clone, so its real effects decide what happens next. See "How it works" in the README.
"""
    (ROOT / "docs/SUBMISSION.md").write_text(text)
    print("wrote docs/SUBMISSION.md", "(numbers filled)" if measured else "(numbers pending)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
