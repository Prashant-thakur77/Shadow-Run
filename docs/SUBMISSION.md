# Lablab submission

Written for: lablab.ai judges and the entry form. Paste each section into its field.

## Title

Shadow Run

## Short description

Your agent wants to touch prod. Shadow Run lets it break a clone first: it rehearses every risky SQL or shell plan in a microVM on Vultr, measures the blast radius, and only lets through what matches.

## Long description

AI agents with real access keep destroying production data with one command. In April 2026 a coding agent at PocketOS deleted a production volume and its backups in nine seconds, by its founder's account. In February, a `terraform destroy` took down DataTalks.Club for about a day. In both, keeping dev and prod apart didn't help, because the agent found a credential that reached prod, and the damage hid in side effects nobody had listed.

Shadow Run sits between an agent and production and holds the only credential. The agent gets three tools: inspect a clone, rehearse a plan, ask to apply it. A plan is frozen and hashed, read by a static gate, and run on a full clone of prod inside a fresh Microsandbox microVM with no network device and no secrets. Postgres itself reports what happened: rows per table, each foreign-key cascade traced to the step that caused it, schema changes, before and after samples. Business guardrails that the agent can't edit run in the same transaction. On failure, the measurements go back to the agent, and it revises and rehearses again on a new clone.

Small reversible changes that fit the team's budget go through. Everything else waits for a different person, who approves those exact hashes, and a changed or replayed approval gets a 409. The same plan then runs on prod in one transaction, with the touched tables locked and re-checked for drift. If counts, schema or guardrails differ from the rehearsal at all, it rolls back. A backup and a signed evidence bundle go to Object Storage.

(Fill in after the final benchmark: run scripts/make_submission.py again.) (Fill in after the final benchmark: run scripts/make_submission.py again.) (Fill in after the final benchmark: run scripts/make_submission.py again.) 7 of 7 red-team attacks contained, checked from the host, with prod's hash unchanged. 18 of 18 attempts to break the approval and apply were refused or rolled back as designed. The rubber-stamp gap and the other limits are published in the README: side effects outside the target can't be rehearsed, some harm needs a person to notice, and clone cost grows with database size.

It ships as an MCP server, so OpenCode, Claude Code or Cursor can route risky actions through it, plus a web app and a CLI for CI. Every LLM call goes to Vultr Serverless Inference, and the model never grades itself: it proposes plans and explains results, while Postgres measures and frozen checks decide.

Built on Vultr: VX1 for the microVMs, Cloud Compute for the control plane, Serverless Inference, Managed PostgreSQL, Object Storage and a VPC, all created from zero by one script and removed by another.

## Tags

AI agents, MCP, sandbox, microVM, Postgres, Vultr, security, DevOps, guardrails, human in the loop

## Category

Challenge 1: Blast Radius Zero

## Links

Application URL: https://45-76-245-71.sslip.io

GitHub: https://github.com/Prashant-thakur77/Shadow-Run

Demo video: (upload the file, then paste the link here)

Slides: (upload the deck)

## Use case and how the agent executes real tasks

A team lets a coding agent run migrations and data cleanups. Today that means giving it a database URL. With Shadow Run the agent gets no credential, and the plan it writes runs for real on a clone, so its real effects decide what happens next. See "How it works" in the README.
