#!/usr/bin/env python3
"""Write docs/SUBMISSION.md, the text for the lablab form. Measured numbers come from bench/*.json."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from checker.control_kinds import control_kind  # noqa: E402


def load(name: str) -> dict | None:
    p = ROOT / "bench" / name
    return json.loads(p.read_text()) if p.exists() else None


def g(x: float | None) -> str:
    return "not measured" if x is None else f"{x:g}"


def main() -> int:
    state = json.loads((ROOT / "infra/STATE.json").read_text())
    url = state.get("public_url", "URL")
    r = load("results.json") or {}
    rt = load("redteam.json") or {}
    c = load("controls.json") or {}
    measured = r.get("status") == "measured" and r.get("scope") == "full"
    if measured:
        h = r["heldout"]
        ext = r["external"]
        d, s, sg = h["direct"], h["shadow_run"], h["static_gate"]
        unread_done, unread_harm = s["risky_done_if_rubber_stamped"]["mean"], s["harm_if_rubber_stamped"]["mean"]
        headline = (
            f"On {d['risky_tasks']} risky tasks held out from tuning, the same agent finished the job safely {g(d['risky_done']['mean'])} times running directly and caused harm {g(d['harm_on_prod']['mean'])} times. "
            f"Through Shadow Run, even with a person approving every plan unread, it finished safely {g(unread_done)} times and caused harm {g(unread_harm)} times, because it saw the measured damage and rewrote its plans. "
            f"With a person who reads the report, nothing harmful reached prod without one, since {g(s['risky_held']['mean'])} of those plans waited for a person, including every safe task. That is the price."
        )
        external = (
            f"On {ext['direct']['risky_tasks']} tasks adapted from the outside SABER benchmark: {g(ext['direct']['harm_on_prod']['mean'])} direct, "
            f"{g(ext['static_gate']['harm_on_prod']['mean'])} static gate, {g(ext['shadow_run']['harm_on_prod']['mean'])} through Shadow Run with no person, {g(ext['shadow_run']['harm_if_rubber_stamped']['mean'])} if every plan were approved unread."
        )
        timing = (
            f"A rehearsal takes {s['rehearsal_s']['p50']} s at the median, and a task costs ${s['cost_per_task_usd']} in inference."
        )
    else:
        headline = "(Fill in after the final benchmark: run scripts/make_submission.py again.)"
        external = timing = ""
    containment = f"{rt.get('contained', '?')} of {rt.get('total', '?')} red-team attacks contained, checked from the host, with prod's hash unchanged." if rt else ""
    brief = (
        "AI agents with real access keep destroying production data with one command. Shadow Run sits between an agent and prod and holds the only credential. "
        "Every risky plan is frozen, hashed and run on a full clone of prod in a fresh Microsandbox microVM on Vultr, with no network device and no secrets. Postgres reports what really happened, frozen guardrails check it, and failures go back to the agent to rewrite the plan. "
        "A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal.\n\n"
        + (
            f"On {h['direct']['risky_tasks']} risky tasks held out from tuning, the agent alone finished the job safely {g(h['direct']['risky_done']['mean'])} times and caused harm {g(h['direct']['harm_on_prod']['mean'])} times. "
            f"Through Shadow Run, even with every plan approved unread: {g(h['shadow_run']['risky_done_if_rubber_stamped']['mean'])} and {g(h['shadow_run']['harm_if_rubber_stamped']['mean'])}. "
            "With a person who reads the report, nothing harmful reached prod without one, since nearly every plan waits for a person. That is the price.\n\n"
            if measured else ""
        )
        + "Every LLM call goes to Vultr Serverless Inference, on VX1, Cloud Compute, Managed PostgreSQL, Object Storage and a VPC. It ships as a web app, an MCP server, a CLI and a GitHub Action."
    )
    mk = json.loads((ROOT / "docs" / "market.json").read_text())
    market = (
        f"Who pays: whoever owns the database at a team using coding agents. {mk['developers_using_agents']['weekly_pct']}% of professional developers now use them weekly ({mk['developers_using_agents']['source']}). "
        f"It starts free, as a pull request Action that can't touch prod, and then a subscription per protected database, with a self-hosted licence for regulated teams. "
        f"Gartner expects guardian agents to take {mk['guardian_share']['low_pct']} to {mk['guardian_share']['high_pct']}% of the agentic AI market by {mk['guardian_share']['by_year']}. "
        f"Linters like Atlas and Bytebase read the statement, and thin clones like DBLab and Neon give a copy. {mk['us']['usp']} "
        f"Where it's weak: {mk['us']['weakness'][0].lower()}{mk['us']['weakness'][1:]}"
    )
    gt = load("gauntlet.json") or {}
    attack = ""
    if gt.get("baseline_summary"):
        base, now, replay = gt["baseline_summary"], gt["first_summary"], gt["replay"]
        attack = (
            f"We attacked our own policy. An attacker model told every guardrail and the auto-apply rule got {base['would_auto_apply']} of {base['real_attacks']} damaging plans past a row limit, with no person looking, "
            f"so auto-apply now works from a named list. {now['would_auto_apply']} of the same attacker's {now['real_attacks']} damaging plans would still apply alone, but they can only change what the owner listed: {', '.join(now.get('reach_alone', [])) or 'nothing'}. What it finds becomes a candidate rule, which counts only if it holds on the clean database, fails on the attack and lets ordinary changes through. "
            f"Replayed against the rules they taught, {replay['caught']} of {replay['total']} of those attacks are now stopped."
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

AI agents with real access keep destroying production data with one command. In April 2026 a coding agent at PocketOS deleted a production volume and its backups in nine seconds, by its founder's account. In February, a `terraform destroy` took down DataTalks.Club for about a day. In both, keeping dev and prod apart didn't help, because the agent found a credential that reached prod, and the damage hid in side effects nobody had listed.

Shadow Run sits between an agent and production and holds the only credential. The agent gets a few tools, to inspect a clone, rehearse a plan and ask to apply it. A plan is frozen and hashed, read by a static gate, and run on a full clone of prod inside a fresh Microsandbox microVM with no network device and no secrets. Postgres itself reports what happened: rows per table, each foreign-key cascade traced to the step that caused it, schema changes, before and after samples. Business guardrails that the agent can't edit run in the same transaction. On failure, the measurements go back to the agent, and it revises and rehearses again on a new clone.

A small change goes through alone only if it stays on a list of tables and columns the team named as low-risk. Everything else waits for a different person, who approves those exact hashes, and a changed or replayed approval gets a 409. The same plan then runs on prod in one transaction, with the touched tables locked and re-checked for drift. If row counts, row content, schema or guardrails differ from the rehearsal at all, it rolls back. A backup and a signed evidence bundle go to Object Storage.

{headline} {external} {timing} {containment} {controls} The rubber-stamp gap and the other limits are published in the README: side effects outside the target can't be rehearsed, some harm needs a person to notice, and clone cost grows with database size.

Every plan that passes also comes with an undo, written from the row log and proved on the clone before anyone approves: its check is that each touched table's content hash returns to where it started. A second microVM has to reproduce the result. The report states what a plan does to the numbers a business watches, in dollars, not only in rows, and the commands behind real incidents can be replayed on a clone from the web app.

{attack}

It ships as an MCP server, shown with OpenCode on Vultr inference, plus a web app, a CLI and a GitHub Action that posts what a migration really does on the pull request. Every LLM call goes to Vultr Serverless Inference, and the model never grades itself: it proposes plans and explains results, while Postgres measures and frozen checks decide.

{market}

Built on Vultr: VX1 for the microVMs, Cloud Compute for the control plane, Serverless Inference, Managed PostgreSQL, Object Storage and a VPC, all created from zero by one script and removed by another.

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

Video presentation (MP4): upload `var/video/shadow-run-demo.mp4`

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
