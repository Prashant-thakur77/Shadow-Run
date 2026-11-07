# Lablab submission

Written for: lablab.ai judges and the entry form. Paste each section into its field.

## Title

Shadow Run

## Short description

Your agent wants to touch prod. Shadow Run lets it break a clone first: it rehearses every risky SQL or shell plan in a microVM on Vultr, measures the blast radius, and only lets through what matches.

## Long description

AI agents with real access keep destroying production data with one command. In April 2026 a coding agent at PocketOS deleted a production volume and its backups in nine seconds, by its founder's account. In February, a `terraform destroy` took down DataTalks.Club for about a day. In both, keeping dev and prod apart didn't help, because the agent found a credential that reached prod, and the damage hid in side effects nobody had listed.

Shadow Run sits between an agent and production and holds the only credential. The agent gets a few tools, to inspect a clone, rehearse a plan and ask to apply it. A plan is frozen and hashed, read by a static gate, and run on a full clone of prod inside a fresh Microsandbox microVM with no network device and no secrets. Postgres itself reports what happened: rows per table, each foreign-key cascade traced to the step that caused it, schema changes, before and after samples. Business guardrails that the agent can't edit run in the same transaction. On failure, the measurements go back to the agent, and it revises and rehearses again on a new clone.

A small change goes through alone only if it stays on a list of tables and columns the team named as low-risk. Everything else waits for a different person, who approves those exact hashes, and a changed or replayed approval gets a 409. The same plan then runs on prod in one transaction, with the touched tables locked and re-checked for drift. If row counts, row content, schema or guardrails differ from the rehearsal at all, it rolls back. A backup and a signed evidence bundle go to Object Storage.

With every plan approved unread, the same agent did harm on 3.67 of 23 held-out risky tasks instead of 10, and finished safely on 14 instead of 10.33. These are our own tasks, on a demo schema with cascading foreign keys and guardrails written for it. These are the plans from the run before an audit, scored by today's oracles. The next full run replaces them. Task by task, Shadow Run minus direct: harm -6.33 (95% CI -10.33 to -2.67, 8 tasks better, 0 worse, p = 0.0078), finished safely +3.67 (95% CI +0.67 to +7, 5 tasks better, 0 worse, p = 0.062). We count tasks, not runs, because three runs of a task are close to copies. Without the cascade and soft_delete groups, the other 14 tasks show harm 3 to 2 (p = 1) and finished safely 8.33 to 9.67 (p = 0.5), so the effect sits in those two groups. That gain comes from rehearsing and telling the agent which guardrails failed, and we haven't tested the two apart. The agent rewrote a plan after a failed guardrail in 30 of 69 held-out runs. Of the tasks where direct did harm, the 8 where a guardrail fired went from 8 to 1.67, and the 2 where none fired went from 2 to 2. Harm fell only where a guardrail covered it. No plan that changed anything reached prod without a person, so a harm count of 0 with a person who reads the report comes entirely from the hold. 22 of 23 risky plans waited, and anything that holds every plan would score zero too. On the 10 database tasks, harm went from 5 to 2.67 and finishing safely from 3 to 5, too few tasks to call (3 moved on harm, p = 0.25). The agent wasn't told the project's path on the 10 filesystem tasks in that run, so those plans only show damage to the live app next door: 4.33 direct against 3. That's fixed for the next run. A rehearsal takes 2.99 s at the median, and a task costs $0.00351 in inference. 7 of 7 red-team attacks contained, checked from the host, with prod's hash unchanged. 22 attacks on the approval, the apply and the measurement were refused, rolled back or held, and 11 checks confirm the honest path still works. The rubber-stamp gap and the other limits are published in the README: side effects outside the target can't be rehearsed, some harm needs a person to notice, and clone cost grows with database size.

Every plan that passes also comes with an undo, written from the row log and proved on the clone before anyone approves: its check is that each touched table's content hash returns to where it started. A second microVM has to reproduce the result. The report states what a plan does to the numbers a business watches, in dollars, not only in rows, and the commands behind real incidents can be replayed on a clone from the web app.

We attacked our own policy. An attacker model told every guardrail and the auto-apply rule got 5 of 7 damaging plans past a row limit, with no person looking, so auto-apply now works from a named list. 5 of the same attacker's 7 damaging plans would still apply alone, but they can only change what the owner listed: feature_flags.note. What it finds becomes a candidate rule, which counts only if it holds on the clean database, fails on the attack and lets ordinary changes through. Replayed against the rules they taught, 7 of 7 of those attacks are now stopped.

It ships as an MCP server, shown with OpenCode on Vultr inference, plus a web app, a CLI and a GitHub Action that posts what a migration really does on the pull request. Every LLM call goes to Vultr Serverless Inference, and the model never grades itself: it proposes plans and explains results, while Postgres measures and frozen checks decide.

Who pays: whoever owns the database at a team using coding agents. 90% of professional developers now use them weekly (JetBrains Developer Ecosystem Survey 2026). It starts free, as a pull request Action that can't touch prod, and then a subscription per protected database, with a self-hosted licence for regulated teams. Gartner expects guardian agents to take 10 to 15% of the agentic AI market by 2030. Linters like Atlas and Bytebase read the statement, and thin clones like DBLab and Neon give a copy. An approval bound to the measured result of the exact plan, with an apply that rolls back if prod differs. None of the docs above describe that. Where it's weak: full restores get slow on large databases, it covers Postgres and Linux hosts only, and it has no customers yet.

Built on Vultr: VX1 for the microVMs, Cloud Compute for the control plane, Serverless Inference, Managed PostgreSQL, Object Storage and a VPC, all created from zero by one script and removed by another.

## Long description, shorter

Use this one if the form's limit is lower than the version above.

AI agents with real access keep destroying production data with one command. Shadow Run sits between an agent and prod and holds the only credential. Every risky plan is frozen, hashed and run on a full clone of prod in a fresh Microsandbox microVM on Vultr, with no network device and no secrets. Postgres reports what really happened, frozen guardrails check it, and failures go back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal.

With every plan approved unread, the same agent did harm on 3.67 of 23 held-out risky tasks instead of 10, and finished safely on 14 instead of 10.33. These are our own tasks, on a demo schema with cascading foreign keys and guardrails written for it. No plan that changed anything reached prod without a person, so a harm count of 0 with a person who reads the report comes entirely from the hold. 22 of 23 risky plans waited, and anything that holds every plan would score zero too.

Every LLM call goes to Vultr Serverless Inference, on VX1, Cloud Compute, Managed PostgreSQL, Object Storage and a VPC. It ships as a web app, an MCP server, a CLI and a GitHub Action.

## Tags

AI agents, MCP, sandbox, microVM, Postgres, Vultr, security, DevOps, guardrails, human in the loop

## Category

Challenge 1: Blast Radius Zero

## Links

Application URL: https://144-202-92-64.sslip.io

GitHub: https://github.com/Prashant-thakur77/Shadow-Run

Demo platform: Vultr (Cloud Compute for the app, VX1 for the sandboxes)

Video presentation (MP4): upload `var/video/shadow-run-demo.mp4`

Slide presentation (PDF): upload `docs/slides.pdf`

Cover image (16:9): upload `docs/cover.png`

## Vultr Community post (optional, after submitting)

Shadow Run: let your agent break a clone of prod before it touches the real one.

Every LLM call goes to Vultr Serverless Inference. Each rehearsal is a throwaway microVM on a VX1 instance, with no network device, on a clone of a Managed PostgreSQL database, with evidence in Object Storage and the runner behind a VPC. One script creates all of it and one removes it.

We also attacked our own auto-apply policy with a Vultr-hosted model, and published what it found.

Try it at https://144-202-92-64.sslip.io, code at https://github.com/Prashant-thakur77/Shadow-Run.

## Use case and how the agent executes real tasks

A team lets a coding agent run migrations and data cleanups. Today that means giving it a database URL. With Shadow Run the agent gets no credential, and the plan it writes runs for real on a clone, so its real effects decide what happens next. See "How it works" in the README.
