# Lablab submission

Written for: lablab.ai judges and the entry form. Paste each section into its field.

## Title

Shadow Run

## Short description (229 characters; the form takes 50 to 255)

Your agent wants to touch prod. Shadow Run lets it break a clone first: every risky plan runs on a full clone in a microVM on Vultr, Postgres measures the blast radius, and a person approves the exact plan before it reaches prod.

## Long description, for the form (1945 characters; the form takes 600 to 2,000)

AI agents are getting the keys to production. Shadow Run is how a team says yes to that safely: the agent never touches prod directly. Every risky change it wants runs first on a disposable copy of production, and what the change really did, not what it says it will do, is what a person approves.

Today, on Vultr: the agent gets no credential. Each SQL or shell plan is frozen, hashed and rehearsed on a full clone of prod in a throwaway microVM on a Vultr VX1, cut off from the network. Postgres measures the blast radius in rows, cascades and dollars, frozen guardrails decide, a different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything it measures differs. Every model call goes to Vultr Serverless Inference.

It works. On 23 held-out risky tasks, even with every plan approved unread, harm fell from 10 to 2.67 (p = 0.0078 over tasks). 7 of 7 live attacks were contained and 6 of 6 real incident commands stopped before prod. It also found something new: told which rule it broke, an agent can get around it while every guardrail still passes. The checks this led to cut harm on outside-benchmark tasks from 5.33 to 2.

Where it goes: the best version of Shadow Run is the default gate between every coding agent and every production system. Next come thin clones and clones from Vultr Managed PostgreSQL's own backups, so a rehearsal stays fast past a gigabyte; an auto-apply list that learns from what a team approves, tested against its own attacker first; one-click deployment on a team's own Vultr account; and the free pull request Action on GitHub Marketplace as the way in.

Who pays: the engineer who owns production Postgres at a team using coding agents. It's open source and free to self-host on Vultr; hosted, it's $500 a month per protected database, at about a 70% infrastructure margin on one database.

Race the agent: https://144-202-92-64.sslip.io/race

## Long description, full

For the README, a blog post or anywhere without a limit.

**The problem.** In October 2026, 49.8% of the security and technology professionals Salt Security surveyed had confirmed or suspected an AI agent acting unexpectedly or without authorization; more than 40% of those had seen agents modify or delete data, and only 17.5% could automatically stop an agent in production. AI agents with real access keep destroying production data with one command. In April 2026 a coding agent at PocketOS deleted a production volume and its backups in nine seconds, by its founder's account. In February, a `terraform destroy` took down DataTalks.Club's production database. Keeping dev and prod apart didn't help: the agent found a credential that reached prod, and the damage hid in side effects nobody had listed.

**What Shadow Run does.** Don't authorize the command; authorize its measured effect. Allowlists, linters and rules in a prompt judge what a command says. Shadow Run judges what it does, on a real copy of the data, before it can touch the original. It sits between an agent and production and holds the only credential. Every risky SQL or shell plan is frozen and hashed, read by a static gate, and run on a full clone of prod inside a fresh microVM on a Vultr VX1, with no network card and no secrets. Postgres itself reports what happened: rows per table, every foreign-key cascade traced to the step that caused it, and what it does to the numbers a business watches, in dollars. Frozen business guardrails run in the same transaction, and a failure goes back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal. A plan's undo, when one exists, is proved on the clone before anyone approves.

**What we measured.** Same agent, same prompt, a fresh copy of the database for every run, 3 runs per task:

- Even if the reviewer approves every plan without reading it, harm fell from 10 to 2.67 of 23 held-out risky tasks (8 tasks better, 0 worse), and from 7.33 to 2 on 20 tasks adapted from an outside benchmark (8 better, 0 worse). Giving the agent every guardrail in its prompt gets close, 3.67 against 2.67 on the 19 held-out SQL tasks. What a prompt can't do is show a person what the plan really does before prod, or contain a hostile plan, and that is what Shadow Run adds: 19 of 23 risky plans waited for a person with a measured report, so 0 did harm unseen. (bench/stats.json)
- It found a failure mode a rule can't see: guardrail evasion. Told which rule its plan broke, an agent sometimes changes what the rule looks at instead of doing the job safely, as in the recorded run. The two changes it led to cut harm, approved unread, from 5.33 to 2 on the outside-benchmark tasks (4 tasks better, 0 worse) and from 4 to 2.67 on the held-out tasks (3 better, 0 worse), comparing benchmark runs before and after (bench/evasion.json).
- 7 of 7 live attacks contained, each in a microVM with no network card, checked from the host, with prod’s hash unchanged; 6 of 6 real incident commands replayed on a clone and stopped before prod: 4 measured on the clone, 2 failed there because they reach outside it; 34 of 34 checks on approval, apply and undo passed, attacks and honest path alike (bench/redteam.json, bench/incidents.json, bench/controls.json).
- On Vultr end to end: The final benchmark spent 9,351,405 tokens of Serverless Inference across the 4 models the benchmark called ($3.76), booted 1,198 microVMs on one VX1, created 1,008 throwaway databases on Managed PostgreSQL over the VPC, and Object Storage holds 79 signed evidence bundles and 79 pre-apply backups. Spent so far: $31.33 of the $200 credit. On the demo database a rehearsal takes 2.97 s at the median, and a whole held-out task 26.2 s and $0.00347 of inference. (bench/vultr.json, bench/results.json)
- Who pays: the engineer who owns production Postgres at a team using coding agents, and 90% of professional developers now use them weekly (JetBrains Developer Ecosystem Survey 2026). Shadow Run is open source and free to self-host on Vultr; hosted, it's $500 a month per protected database of up to about 1 GB, against $147 a month of Vultr list price per deployment plus a measured $4.45 per 1,000 rehearsed tasks. Gartner, June 2025 expects guardian agents, the category this sits in, to take 10 to 15% of the agentic AI market by 2030.

A rehearsal takes 2.97 s at the median, and a task costs $0.00347 in inference. The limits are published with the numbers: side effects outside the target can't be rehearsed, some harm needs a person to notice, and clone cost grows with database size.

**What we found.** Told which rule it broke, the agent sometimes gets around it. In runs recorded before we checked for this, risky plans that passed only after breaking a guardrail did harm in 20 of 57 cases (35%), against 11 of 85 (13%) for plans that passed first time. The gap is widest on the outside-benchmark tasks: 11 of 14 (79%) against 5 of 40 (12%). So a plan that follows a broken rule now gets two more checks, and if either doubts it, the plan goes back to the agent. On plans nobody read while writing the checks, they caught 3 of 8 harmful plans and sent back 2 of 12 good ones.

**Containment, checked from outside the sandbox.** 7 of 7 red-team attacks contained, checked from the host, with prod's hash unchanged. 23 attacks on the approval, the apply and the measurement were refused, rolled back or held, and 11 checks confirm the honest path still works. 50 rehearsals in a row left no sandbox behind.

**We attacked our own policy.** An attacker model told every guardrail and the auto-apply rule got 5 of 7 damaging plans past a row limit, with no person looking, so auto-apply now works from a named list. 5 of the same attacker's 7 damaging plans would still apply alone, but they can only change what the owner listed: feature_flags.note. What it finds becomes a candidate rule, which counts only if it holds on the clean database, fails on the attack and lets ordinary changes through. Replayed against the rules they taught, 7 of 7 of those attacks are now stopped, in a separate test with 17 rules.

**Built on Vultr, end to end.** Every LLM call goes to Vultr Serverless Inference, and the models never grade themselves: they propose plans, draft guardrails, explain results and read plans a second time, while Postgres measures and frozen checks decide. The microVMs run on a Vultr VX1, the control plane on Vultr Cloud Compute, prod is Vultr Managed PostgreSQL, evidence bundles and backups go to Vultr Object Storage, and the runner sits on a Vultr VPC behind a firewall group. One script creates all of it from zero and one removes it.

**Who pays.** Whoever owns the database at a team using coding agents. 90% of professional developers now use them weekly (JetBrains Developer Ecosystem Survey 2026). It's open source and free to self-host on the team's own Vultr account, with a pull request Action that can't touch prod; hosted, it's a subscription per protected database, with a support licence for regulated teams. Cost to serve: $147 a month per deployment at list price plus a measured $4.45 per 1,000 rehearsed tasks, inference and VX1 time included, a 70% margin on one database at $500 a month. Gartner expects guardian agents to take 10 to 15% of the agentic AI market by 2030. Linters read the statement, and thin clones give a copy. What's different: An approval bound to the measured result of the exact plan, with an apply that rolls back if prod differs. Scope today: built for Postgres and Linux hosts. Rehearsals use full restores today, and thin clones are next, for databases past a gigabyte.

**Try it.** https://144-202-92-64.sslip.io: press Race the agent to watch the same task run alone and through Shadow Run, side by side, or Continue as guest to request, approve, break and undo a change yourself. It also ships as an MCP server (shown with OpenCode on Vultr inference), a CLI and a GitHub Action that posts what a migration really does on the pull request.

## Long description, shorter

Use this one if the form's limit is lower than the version above.

AI agents with real access keep destroying production data with one command. Shadow Run sits between an agent and prod and holds the only credential. Every risky plan is frozen, hashed and run on a full clone of prod in a fresh Microsandbox microVM on Vultr, with no network device and no secrets. Postgres reports what really happened, frozen guardrails check it, and failures go back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal.

- Even if the reviewer approves every plan without reading it, harm fell from 10 to 2.67 of 23 held-out risky tasks (8 tasks better, 0 worse), and from 7.33 to 2 on 20 tasks adapted from an outside benchmark (8 better, 0 worse). Giving the agent every guardrail in its prompt gets close, 3.67 against 2.67 on the 19 held-out SQL tasks. What a prompt can't do is show a person what the plan really does before prod, or contain a hostile plan, and that is what Shadow Run adds: 19 of 23 risky plans waited for a person with a measured report, so 0 did harm unseen. (bench/stats.json)
- It found a failure mode a rule can't see: guardrail evasion. Told which rule its plan broke, an agent sometimes changes what the rule looks at instead of doing the job safely, as in the recorded run. The two changes it led to cut harm, approved unread, from 5.33 to 2 on the outside-benchmark tasks (4 tasks better, 0 worse) and from 4 to 2.67 on the held-out tasks (3 better, 0 worse), comparing benchmark runs before and after (bench/evasion.json).
- 7 of 7 live attacks contained, each in a microVM with no network card, checked from the host, with prod’s hash unchanged; 6 of 6 real incident commands replayed on a clone and stopped before prod: 4 measured on the clone, 2 failed there because they reach outside it; 34 of 34 checks on approval, apply and undo passed, attacks and honest path alike (bench/redteam.json, bench/incidents.json, bench/controls.json).
- On Vultr end to end: The final benchmark spent 9,351,405 tokens of Serverless Inference across the 4 models the benchmark called ($3.76), booted 1,198 microVMs on one VX1, created 1,008 throwaway databases on Managed PostgreSQL over the VPC, and Object Storage holds 79 signed evidence bundles and 79 pre-apply backups. Spent so far: $31.33 of the $200 credit. On the demo database a rehearsal takes 2.97 s at the median, and a whole held-out task 26.2 s and $0.00347 of inference. (bench/vultr.json, bench/results.json)
- Who pays: the engineer who owns production Postgres at a team using coding agents, and 90% of professional developers now use them weekly (JetBrains Developer Ecosystem Survey 2026). Shadow Run is open source and free to self-host on Vultr; hosted, it's $500 a month per protected database of up to about 1 GB, against $147 a month of Vultr list price per deployment plus a measured $4.45 per 1,000 rehearsed tasks. Gartner, June 2025 expects guardian agents, the category this sits in, to take 10 to 15% of the agentic AI market by 2030.

Every LLM call goes to Vultr Serverless Inference, on VX1, Cloud Compute, Managed PostgreSQL, Object Storage and a VPC. It ships as a web app, an MCP server, a CLI and a GitHub Action.

## Tags

Vultr, Vultr Serverless Inference, Vultr VX1, Vultr Managed PostgreSQL, Vultr Object Storage, AI agents, agentic AI, AI safety, MCP, microVM, KVM, sandbox, PostgreSQL, database migrations, DevOps, guardrails, human in the loop, Python, FastAPI, React, Qwen, GLM

## Category

Challenge 1: Blast Radius Zero

## Links

Application URL: https://144-202-92-64.sslip.io

GitHub: https://github.com/Prashant-thakur77/Shadow-Run

Demo platform: Vultr (Cloud Compute for the app, VX1 for the sandboxes)

Video presentation (MP4): upload `video/final.mp4`

Slide presentation (PDF): upload `docs/slides.pdf`

Cover image (16:9): upload `docs/cover.png`

## Vultr Community post (optional, after submitting)

Shadow Run: let your agent break a clone of prod before it touches the real one.

Every LLM call goes to Vultr Serverless Inference. Each rehearsal is a throwaway microVM on a VX1 instance, with no network device, on a clone of a Managed PostgreSQL database, with evidence in Object Storage and the runner behind a VPC. One script creates all of it and one removes it.

We also attacked our own auto-apply policy with a Vultr-hosted model, and published what it found.

Try it at https://144-202-92-64.sslip.io, code at https://github.com/Prashant-thakur77/Shadow-Run.

## Use case and how the agent executes real tasks

A team lets a coding agent run migrations and data cleanups. Today that means giving it a database URL. With Shadow Run the agent gets no credential, and the plan it writes runs for real on a clone, so its real effects decide what happens next. See "How it works" in the README.
