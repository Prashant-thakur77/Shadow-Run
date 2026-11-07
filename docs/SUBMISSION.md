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

With every plan approved unread, the same agent did harm on 4 of 23 held-out risky tasks instead of 10.33, and finished safely on 13 instead of 10.67. These are our own tasks, on a demo schema with cascading foreign keys and guardrails written for it. Task by task, Shadow Run minus direct: harm -6.33 (95% CI -10.33 to -2.67, 9 tasks better, 0 worse, p = 0.0039), finished safely +2.33 (95% CI -1 to +6, 4 tasks better, 2 worse, p = 0.31). We count tasks, not runs, because three runs of a task are close to copies. Without the cascade and soft_delete groups, the other 14 tasks show harm 3 to 2 (p = 1) and finished safely 9 to 8.33 (p = 0.75), so the effect sits in those two groups. Those two middle columns test what rehearsing adds. Rules in the prompt gives the agent the same guardrails up front, and the plan runs directly. Transaction with rollback checks the same guardrails in a transaction on the database, with the same retries and feedback, and no microVM. Against rules in the prompt, Shadow Run differs by +0.33 on harm (95% CI -1 to +2, p = 1) and -1 on finishing safely (95% CI -2 to +0, p = 0.25). Against the rollback arm, Shadow Run differs by +0 on harm (95% CI +0 to +0, p = 1) and +0.33 on finishing safely (95% CI -1.33 to +2, p = 1). We can't tell Shadow Run's plans from the rollback arm's at this sample size, so a better plan isn't something rehearsing has been shown to add over a transaction with the same checks. Just telling the agent the rules up front cut harm by 5.67 tasks against direct (95% CI -9.67 to -2.33). This table scores plans. It doesn't measure what the microVM is for, which is keeping a plan away from the real database until someone has seen what it does. The agent rewrote a plan after a failed guardrail in 31 of 69 held-out runs. Of the tasks where direct did harm, the 9 where a guardrail fired went from 8.33 to 2, and the 2 where none fired went from 2 to 2. Harm fell only where a guardrail covered it. No plan that changed anything reached prod without a person, so a harm count of 0 with a person who reads the report comes entirely from the hold. 22.33 of 23 risky plans waited, and anything that holds every plan would score zero too. On the 10 database tasks, harm went from 4.67 to 3.67 and finishing safely from 3.33 to 4.67, too few tasks to call (2 moved on harm, p = 0.5). On the 10 filesystem tasks, harm went from 1.67 to 1.67 and finishing safely from 3.67 to 4 (p = 1 on harm). A rehearsal takes 3.11 s at the median, and a task costs $0.00324 in inference. 7 of 7 red-team attacks contained, checked from the host, with prod's hash unchanged. 22 attacks on the approval, the apply and the measurement were refused, rolled back or held, and 11 checks confirm the honest path still works.

Told which rule it broke, the agent sometimes gets around it. In runs recorded before we checked for this, risky plans that passed only after breaking a guardrail did harm in 20 of 57 cases (35%), against 11 of 85 (13%) for plans that passed first time. So a plan that follows a broken rule now gets two more checks, and if either doubts it, the plan goes back to the agent. On plans nobody read while writing the checks, they caught 7 of 8 harmful plans and sent back 2 of 12 good ones. The rubber-stamp gap and the other limits are published in the README: side effects outside the target can't be rehearsed, some harm needs a person to notice, and clone cost grows with database size.

Almost every plan that passes also comes with an undo, written from the row log and proved on the clone before anyone approves: its check is that each touched table's content hash returns to where it started. A second microVM has to reproduce the result. The report states what a plan does to the numbers a business watches, in dollars, not only in rows, and the commands behind real incidents can be replayed on a clone from the web app.

We attacked our own policy. An attacker model told every guardrail and the auto-apply rule got 5 of 7 damaging plans past a row limit, with no person looking, so auto-apply now works from a named list. 5 of the same attacker's 7 damaging plans would still apply alone, but they can only change what the owner listed: feature_flags.note. What it finds becomes a candidate rule, which counts only if it holds on the clean database, fails on the attack and lets ordinary changes through. Replayed against the rules they taught, 7 of 7 of those attacks are now stopped, in a separate test with 17 rules.

It ships as an MCP server, shown with OpenCode on Vultr inference, plus a web app, a CLI and a GitHub Action that posts what a migration really does on the pull request. Every LLM call goes to Vultr Serverless Inference, and the model never grades itself: it proposes plans and explains results, while Postgres measures and frozen checks decide.

Who pays: whoever owns the database at a team using coding agents. 90% of professional developers now use them weekly (JetBrains Developer Ecosystem Survey 2026). It starts free, as a pull request Action that can't touch prod, and then a subscription per protected database, with a self-hosted licence for regulated teams. Gartner expects guardian agents to take 10 to 15% of the agentic AI market by 2030. Linters like Atlas and Bytebase read the statement, and thin clones like DBLab and Neon give a copy. An approval bound to the measured result of the exact plan, with an apply that rolls back if prod differs. None of the docs above describe that. Where it's weak: full restores get slow on large databases, it covers Postgres and Linux hosts only, and it has no customers yet.

Built on Vultr: VX1 for the microVMs, Cloud Compute for the control plane, Serverless Inference, Managed PostgreSQL, Object Storage and a VPC, all created from zero by one script and removed by another.

## Long description, shorter

Use this one if the form's limit is lower than the version above.

AI agents with real access keep destroying production data with one command. Shadow Run sits between an agent and prod and holds the only credential. Every risky plan is frozen, hashed and run on a full clone of prod in a fresh Microsandbox microVM on Vultr, with no network device and no secrets. Postgres reports what really happened, frozen guardrails check it, and failures go back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal.

With every plan approved unread, the same agent did harm on 4 of 23 held-out risky tasks instead of 10.33, and finished safely on 13 instead of 10.67. These are our own tasks, on a demo schema with cascading foreign keys and guardrails written for it. No plan that changed anything reached prod without a person, so a harm count of 0 with a person who reads the report comes entirely from the hold. 22.33 of 23 risky plans waited, and anything that holds every plan would score zero too.

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
