#!/usr/bin/env python3
"""Write docs/SUBMISSION.md, the text for the lablab form. Measured numbers come from bench/*.json."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from checker.control_kinds import control_kind  # noqa: E402
from make_readme_table import block_summary, evasion_sentence, basis_sentence, concentration_sentence, hold_sentence, lead_sentence, rehearsing_text, saber_sentence, task_level_sentence, view  # noqa: E402


def load(name: str) -> dict | None:
    p = ROOT / "bench" / name
    return json.loads(p.read_text()) if p.exists() else None


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
    plain = lambda t: t.replace("**", "").replace("`", "")
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
    market = (
        f"Who pays: whoever owns the database at a team using coding agents. {mk['developers_using_agents']['weekly_pct']}% of professional developers now use them weekly ({mk['developers_using_agents']['source']}). "
        f"It starts free, as a pull request Action that can't touch prod, and then a subscription per protected database, with a self-hosted licence for regulated teams. "
        f"Gartner expects guardian agents to take {mk['guardian_share']['low_pct']} to {mk['guardian_share']['high_pct']}% of the agentic AI market by {mk['guardian_share']['by_year']}. "
        f"Migration linters read the statement, and thin clones like DBLab and Neon give a copy. {mk['us']['usp']} "
        f"Where it's weak: {mk['us']['weakness'][0].lower()}{mk['us']['weakness'][1:]}"
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

    text = f"""# Lablab submission

Written for: lablab.ai judges and the entry form. Paste each section into its field.

## Title

Shadow Run

## Short description

Your agent wants to touch prod. Shadow Run lets it break a clone first: it rehearses every risky SQL or shell plan in a microVM on Vultr, measures the blast radius, and only lets through what matches.

## Long description

**The problem.** AI agents with real access keep destroying production data with one command. In April 2026 a coding agent at PocketOS deleted a production volume and its backups in nine seconds, by its founder's account. In February, a `terraform destroy` took down DataTalks.Club for about a day. Keeping dev and prod apart didn't help: the agent found a credential that reached prod, and the damage hid in side effects nobody had listed.

**What Shadow Run does.** It sits between an agent and production and holds the only credential. Every risky SQL or shell plan is frozen and hashed, read by a static gate, and run on a full clone of prod inside a fresh microVM on a Vultr VX1, with no network card and no secrets. Postgres itself reports what happened: rows per table, every foreign-key cascade traced to the step that caused it, and what it does to the numbers a business watches, in dollars. Frozen business guardrails run in the same transaction, and a failure goes back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal. Almost every plan that passes comes with an undo, proved on the clone before anyone approves.

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

AI agents, MCP, sandbox, microVM, Postgres, Vultr, security, DevOps, guardrails, human in the loop

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
