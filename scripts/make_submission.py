#!/usr/bin/env python3
"""Write docs/SUBMISSION.md, the text for the lablab form. Measured numbers come from bench/*.json."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


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
        headline = (
            f"On {d['risky_tasks']} risky tasks held out from tuning, the same agent caused harm on prod {g(d['harm_on_prod']['mean'])} times running directly, "
            f"{g(sg['harm_on_prod']['mean'])} times behind a static rule gate, and {g(s['harm_on_prod']['mean'])} times through Shadow Run. "
            f"If the approver rubber-stamped everything held, that last number would be {g(s['harm_if_rubber_stamped']['mean'])}."
        )
        external = (
            f"On {ext['direct']['risky_tasks']} tasks adapted from the outside SABER benchmark: {g(ext['direct']['harm_on_prod']['mean'])} direct, "
            f"{g(ext['static_gate']['harm_on_prod']['mean'])} static gate, {g(ext['shadow_run']['harm_on_prod']['mean'])} Shadow Run."
        )
        timing = (
            f"A rehearsal takes {s['rehearsal_s']['p50']} s at the median, and a task costs ${s['cost_per_task_usd']} in inference."
        )
    else:
        headline = "(Fill in after the final benchmark: run scripts/make_submission.py again.)"
        external = timing = ""
    containment = f"{rt.get('contained', '?')} of {rt.get('total', '?')} red-team attacks contained, checked from the host, with prod's hash unchanged." if rt else ""
    gt = load("gauntlet.json") or {}
    attack = ""
    if gt.get("baseline_summary"):
        base, now, replay = gt["baseline_summary"], gt["first_summary"], gt["replay"]
        attack = (
            f"We attacked our own policy. An attacker model told every guardrail and the auto-apply rule got {base['would_auto_apply']} of {base['real_attacks']} damaging plans past a row limit, with no person looking, "
            f"so auto-apply now works from a named list. {now['would_auto_apply']} of the same attacker's {now['real_attacks']} damaging plans would still apply alone, but they can only change what the owner listed: {', '.join(now.get('reach_alone', [])) or 'nothing'}. What it finds becomes a candidate rule, which counts only if it holds on the clean database, fails on the attack and lets ordinary changes through. "
            f"Replayed against the rules they taught, {replay['caught']} of {replay['total']} of those attacks are now stopped."
        )
    controls = f"{c.get('passed', '?')} of {c.get('total', '?')} attempts to break the approval and apply were refused or rolled back as designed." if c else ""

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

It ships as an MCP server, so OpenCode, Claude Code or Cursor can route risky actions through it, plus a web app, a CLI and a GitHub Action that posts what a migration really does on the pull request. Every LLM call goes to Vultr Serverless Inference, and the model never grades itself: it proposes plans and explains results, while Postgres measures and frozen checks decide.

Built on Vultr: VX1 for the microVMs, Cloud Compute for the control plane, Serverless Inference, Managed PostgreSQL, Object Storage and a VPC, all created from zero by one script and removed by another.

## Tags

AI agents, MCP, sandbox, microVM, Postgres, Vultr, security, DevOps, guardrails, human in the loop

## Category

Challenge 1: Blast Radius Zero

## Links

Application URL: {url}

GitHub: https://github.com/Prashant-thakur77/Shadow-Run

Demo video: (upload the file, then paste the link here)

Slides: (upload the deck)

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
