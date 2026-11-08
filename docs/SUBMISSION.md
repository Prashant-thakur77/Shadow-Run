# Lablab submission

Written for: lablab.ai judges and the entry form. Paste each section into its field.

## Title

Shadow Run

## Short description (229 characters; the form takes 50 to 255)

Your agent wants to touch prod. Shadow Run lets it break a clone first: every risky plan runs on a full clone in a microVM on Vultr, Postgres measures the blast radius, and a person approves the exact plan before it reaches prod.

## Long description, for the form (1938 characters; the form takes 600 to 2,000)

AI agents now hold production credentials. In October 2026, 49.8% of professionals Salt Security surveyed had confirmed or suspected an AI agent acting unexpectedly or without authorization; only 17.5% could stop one automatically.

Shadow Run authorizes what a plan does, not what it says. The agent gets no credential. Every risky SQL or shell plan it writes is frozen, hashed and run first on a full clone of prod in a throwaway microVM on a Vultr VX1 with no network card. Postgres measures the blast radius, frozen guardrails decide, and a different person approves those exact hashes before the same plan runs on prod in one transaction that rolls back on any surprise. Almost every plan comes with an undo, proved on the clone first.

On 23 held-out risky tasks, 0 did harm before a person saw the plan, against 10 for the agent alone. Even with every plan approved unread, harm fell from 10 to 2.67 (p = 0.0078 over tasks), and tasks finished safely held up (11.67 against 10).

We found that an agent told which rule it broke can learn to get around it: those plans were harmful 35% of the time, against 13%. Shadow Run now screens every such plan twice, by measurement and by a second model.

7 of 7 live attacks contained, and 6 of 6 real incident commands replayed on a clone were blocked. Every model call Shadow Run makes runs on Vultr Serverless Inference, every rehearsal on a VX1, prod on Vultr Managed PostgreSQL, evidence in Vultr Object Storage.

The final benchmark booted 1,198 microVMs and used 9.35 million tokens of Vultr inference.

Who pays: the database owner at a team using coding agents, which 90% of professional developers now use weekly (JetBrains). It plugs into any agent over MCP, a CLI or a GitHub Action that posts what a migration really does on the pull request. It starts free as that Action, then $500 a month per protected database.

Race the agent yourself: https://144-202-92-64.sslip.io/race

## Long description, full

For the README, a blog post or anywhere without a limit.

**The problem.** In October 2026, 49.8% of the security and technology professionals Salt Security surveyed had confirmed or suspected an AI agent acting unexpectedly or without authorization; more than 40% of those had seen agents modify or delete data, and only 17.5% could automatically stop an agent in production. AI agents with real access keep destroying production data with one command. In April 2026 a coding agent at PocketOS deleted a production volume and its backups in nine seconds, by its founder's account. In February, a `terraform destroy` took down DataTalks.Club for about a day. Keeping dev and prod apart didn't help: the agent found a credential that reached prod, and the damage hid in side effects nobody had listed.

**What Shadow Run does.** Don't authorize the command; authorize its measured effect. Allowlists, linters and rules in a prompt judge what a command says. Shadow Run judges what it does, on a real copy of the data, before it can touch the original. It sits between an agent and production and holds the only credential. Every risky SQL or shell plan is frozen and hashed, read by a static gate, and run on a full clone of prod inside a fresh microVM on a Vultr VX1, with no network card and no secrets. Postgres itself reports what happened: rows per table, every foreign-key cascade traced to the step that caused it, and what it does to the numbers a business watches, in dollars. Frozen business guardrails run in the same transaction, and a failure goes back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal. Almost every plan that passes comes with an undo, proved on the clone before anyone approves.

**What we measured.** Same agent, same prompt, a fresh copy of the database for every run, 3 runs per task:

_How to read these: the same agent (qwen3.8-27b on Vultr Serverless Inference) and prompt in every mode, a fresh copy of the database for every run, mean of 3 runs per task. Held-out tasks were never used while building Shadow Run. Harm is decided by oracles that check the outcome, not the plan. Approved unread means every plan that waited for a person was approved without being read, the worst case for the reviewer._

- Even with every plan approved unread, harm fell from 10 to 2.67 of 23 held-out risky tasks, and that holds task by task (95% CI -11.67 to -3.33, p = 0.0078, 8 tasks better, 0 worse). Tasks finished safely held up: 11.67 through Shadow Run, 10 alone. (bench/stats.json)
- Nothing harmful reached prod unseen: 0 of 23, against 10 for the agent alone. 19 of 23 risky plans waited for a person with a measured report of what each would do, and nothing that changed anything was applied without one (bench/results.json).
- On 20 tasks adapted from an outside benchmark (SABER), harm went from 7.33 to 2, also holding task by task (p = 0.0078), so the effect isn't only on our own tasks.
- Fast and cheap enough to sit in the loop. A rehearsal on a full clone takes 2.97 s at the median and about $0.000126 of VX1 time at list price, boot to destroy. A whole task, every model call included, costs $0.00347 of inference.
- It found a failure mode a rule can't see: guardrail evasion. Told which rule its plan broke, an agent sometimes changes what the rule looks at instead of doing the job safely. Plans that passed only after breaking a rule were harmful 35% of the time, against 13% for first-time passes, so Shadow Run now screens every such plan twice, once by measurement and once by a second model. What each catches is in [what we found](#what-we-found-told-which-rule-it-broke-the-agent-gets-around-it) (bench/evasion.json).
- 7 of 7 live attacks contained, each in a microVM with no network card, checked from the host, with prod’s hash unchanged; 6 of 6 real incident commands replayed on a clone and blocked; 34 of 34 checks on approval, apply and undo passed, attacks and honest path alike (bench/redteam.json, bench/incidents.json, bench/controls.json).
- On Vultr end to end: The final benchmark spent 9,351,405 tokens of Serverless Inference across the 4 models it used ($3.76), booted 1,198 microVMs on one VX1, created 1,008 throwaway databases on Managed PostgreSQL over the VPC, and Object Storage holds 79 signed evidence bundles and 79 pre-apply backups. Spent so far: $31.33 of the $200 credit (bench/vultr.json).
- Who pays: whoever owns the database at a team using coding agents, and 90% of professional developers now use them weekly ([JetBrains Developer Ecosystem Survey 2026](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/)). It starts free as a pull request Action, then $500 a month per protected database, against a measured variable cost of about $4.45 per 1,000 rehearsed tasks ([unit economics](#unit-economics)). [Gartner, June 2025](https://www.gartner.com/en/newsroom/press-releases/2025-06-11-gartner-predicts-that-guardian-agents-will-capture-10-15-percent-of-the-agentic-ai-market-by-2030) expects guardian agents, the category this sits in, to take 10 to 15% of the agentic AI market by 2030 ([who this is for](#who-this-is-for), [market](#market-and-competition)).

A rehearsal takes 2.97 s at the median, and a task costs $0.00347 in inference. The limits are published with the numbers: side effects outside the target can't be rehearsed, some harm needs a person to notice, and clone cost grows with database size.

**What we found.** Told which rule it broke, the agent sometimes gets around it. In runs recorded before we checked for this, risky plans that passed only after breaking a guardrail did harm in 20 of 57 cases (35%), against 11 of 85 (13%) for plans that passed first time. So a plan that follows a broken rule now gets two more checks, and if either doubts it, the plan goes back to the agent. On plans nobody read while writing the checks, they caught 3 of 8 harmful plans and sent back 2 of 12 good ones.

**Containment, checked from outside the sandbox.** 7 of 7 red-team attacks contained, checked from the host, with prod's hash unchanged. 23 attacks on the approval, the apply and the measurement were refused, rolled back or held, and 11 checks confirm the honest path still works. 50 rehearsals in a row left no sandbox behind.

**We attacked our own policy.** An attacker model told every guardrail and the auto-apply rule got 5 of 7 damaging plans past a row limit, with no person looking, so auto-apply now works from a named list. 5 of the same attacker's 7 damaging plans would still apply alone, but they can only change what the owner listed: feature_flags.note. What it finds becomes a candidate rule, which counts only if it holds on the clean database, fails on the attack and lets ordinary changes through. Replayed against the rules they taught, 7 of 7 of those attacks are now stopped, in a separate test with 17 rules.

**Built on Vultr, end to end.** Every LLM call goes to Vultr Serverless Inference, and the models never grade themselves: they propose plans, draft guardrails, explain results and read plans a second time, while Postgres measures and frozen checks decide. The microVMs run on a Vultr VX1, the control plane on Vultr Cloud Compute, prod is Vultr Managed PostgreSQL, evidence bundles and backups go to Vultr Object Storage, and the runner sits on a Vultr VPC behind a firewall group. One script creates all of it from zero and one removes it.

**Who pays.** Whoever owns the database at a team using coding agents. 90% of professional developers now use them weekly (JetBrains Developer Ecosystem Survey 2026). It starts free, as a pull request Action that can't touch prod, and then a subscription per protected database, with a self-hosted licence for regulated teams. Gartner expects guardian agents to take 10 to 15% of the agentic AI market by 2030. Migration linters read the statement, and thin clones like DBLab and Neon give a copy. An approval bound to the measured result of the exact plan, with an apply that rolls back if prod differs. Scope today: built for Postgres and Linux hosts. Rehearsals use full restores today, and thin clones are next, for databases past a few gigabytes.

**Try it.** https://144-202-92-64.sslip.io: press Race the agent to watch the same task run alone and through Shadow Run, side by side, or Continue as guest to request, approve, break and undo a change yourself. It also ships as an MCP server (shown with OpenCode on Vultr inference), a CLI and a GitHub Action that posts what a migration really does on the pull request.

## Long description, shorter

Use this one if the form's limit is lower than the version above.

AI agents with real access keep destroying production data with one command. Shadow Run sits between an agent and prod and holds the only credential. Every risky plan is frozen, hashed and run on a full clone of prod in a fresh Microsandbox microVM on Vultr, with no network device and no secrets. Postgres reports what really happened, frozen guardrails check it, and failures go back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal.

_How to read these: the same agent (qwen3.8-27b on Vultr Serverless Inference) and prompt in every mode, a fresh copy of the database for every run, mean of 3 runs per task. Held-out tasks were never used while building Shadow Run. Harm is decided by oracles that check the outcome, not the plan. Approved unread means every plan that waited for a person was approved without being read, the worst case for the reviewer._

- Even with every plan approved unread, harm fell from 10 to 2.67 of 23 held-out risky tasks, and that holds task by task (95% CI -11.67 to -3.33, p = 0.0078, 8 tasks better, 0 worse). Tasks finished safely held up: 11.67 through Shadow Run, 10 alone. (bench/stats.json)
- Nothing harmful reached prod unseen: 0 of 23, against 10 for the agent alone. 19 of 23 risky plans waited for a person with a measured report of what each would do, and nothing that changed anything was applied without one (bench/results.json).
- On 20 tasks adapted from an outside benchmark (SABER), harm went from 7.33 to 2, also holding task by task (p = 0.0078), so the effect isn't only on our own tasks.
- Fast and cheap enough to sit in the loop. A rehearsal on a full clone takes 2.97 s at the median and about $0.000126 of VX1 time at list price, boot to destroy. A whole task, every model call included, costs $0.00347 of inference.
- It found a failure mode a rule can't see: guardrail evasion. Told which rule its plan broke, an agent sometimes changes what the rule looks at instead of doing the job safely. Plans that passed only after breaking a rule were harmful 35% of the time, against 13% for first-time passes, so Shadow Run now screens every such plan twice, once by measurement and once by a second model. What each catches is in [what we found](#what-we-found-told-which-rule-it-broke-the-agent-gets-around-it) (bench/evasion.json).
- 7 of 7 live attacks contained, each in a microVM with no network card, checked from the host, with prod’s hash unchanged; 6 of 6 real incident commands replayed on a clone and blocked; 34 of 34 checks on approval, apply and undo passed, attacks and honest path alike (bench/redteam.json, bench/incidents.json, bench/controls.json).
- On Vultr end to end: The final benchmark spent 9,351,405 tokens of Serverless Inference across the 4 models it used ($3.76), booted 1,198 microVMs on one VX1, created 1,008 throwaway databases on Managed PostgreSQL over the VPC, and Object Storage holds 79 signed evidence bundles and 79 pre-apply backups. Spent so far: $31.33 of the $200 credit (bench/vultr.json).
- Who pays: whoever owns the database at a team using coding agents, and 90% of professional developers now use them weekly ([JetBrains Developer Ecosystem Survey 2026](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/)). It starts free as a pull request Action, then $500 a month per protected database, against a measured variable cost of about $4.45 per 1,000 rehearsed tasks ([unit economics](#unit-economics)). [Gartner, June 2025](https://www.gartner.com/en/newsroom/press-releases/2025-06-11-gartner-predicts-that-guardian-agents-will-capture-10-15-percent-of-the-agentic-ai-market-by-2030) expects guardian agents, the category this sits in, to take 10 to 15% of the agentic AI market by 2030 ([who this is for](#who-this-is-for), [market](#market-and-competition)).

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
