# Lablab submission

Written for: lablab.ai judges and the entry form. Paste each section into its field.

## Title

Shadow Run

## Short description

Your agent wants to touch prod. Shadow Run lets it break a clone first: it rehearses every risky SQL or shell plan in a microVM on Vultr, measures the blast radius, and only lets through what matches.

## Long description

**The problem.** AI agents with real access keep destroying production data with one command. In April 2026 a coding agent at PocketOS deleted a production volume and its backups in nine seconds, by its founder's account. In February, a `terraform destroy` took down DataTalks.Club for about a day. Keeping dev and prod apart didn't help: the agent found a credential that reached prod, and the damage hid in side effects nobody had listed.

**What Shadow Run does.** It sits between an agent and production and holds the only credential. Every risky SQL or shell plan is frozen and hashed, read by a static gate, and run on a full clone of prod inside a fresh microVM on a Vultr VX1, with no network card and no secrets. Postgres itself reports what happened: rows per table, every foreign-key cascade traced to the step that caused it, and what it does to the numbers a business watches, in dollars. Frozen business guardrails run in the same transaction, and a failure goes back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal. Almost every plan that passes comes with an undo, proved on the clone before anyone approves.

**What we measured.** Same agent, same prompt, a fresh copy of the database for every run, 3 runs per task:

- 0 of 23 held-out risky tasks did harm on prod before a person saw the plan. The same agent alone did harm on 9.67. Nothing that changed anything went through without a person: 17.33 of 23 risky plans waited, which is where the zero comes from (bench/results.json).
- Approved unread, harm went from 9.67 to 2, and that holds task by task (95% CI -12 to -3.67, p = 0.0078). Work done: 11.33 alone, 11.33 through Shadow Run, which this sample can't separate (p = 1). (bench/stats.json)
- Rules in the prompt cut harm about as much: 3 against Shadow Run's 2 on 19 SQL tasks, which this sample can't separate. The difference is when it lands: a prompt's plan runs on prod with nobody looking.
- Told which rule it broke, the agent sometimes gets around it. Plans that passed only after breaking a rule were harmful 35% of the time, against 13% for first-time passes. A measured check and a second model now send those plans back: 7 of 8 harmful caught on plans neither had seen, 2 of 12 good sent back by mistake (bench/evasion.json).
- 7 of 7 live attacks contained, each in a microVM with no network card, checked from the host, with prod’s hash unchanged (bench/redteam.json).
- On Vultr end to end: The final benchmark spent 9,549,968 tokens of Serverless Inference across 4 models ($3.79), booted 1,219 microVMs on one VX1, created and dropped 1,008 databases on Managed PostgreSQL over the VPC, and Object Storage holds 138 evidence bundles and pre-apply backups. Spent so far: $26.21 of the $200 credit (bench/vultr.json).

A rehearsal takes 2.93 s at the median, and a task costs $0.0033 in inference. The limits are published with the numbers: side effects outside the target can't be rehearsed, some harm needs a person to notice, and clone cost grows with database size.

**What we found.** Told which rule it broke, the agent sometimes gets around it. In runs recorded before we checked for this, risky plans that passed only after breaking a guardrail did harm in 20 of 57 cases (35%), against 11 of 85 (13%) for plans that passed first time. So a plan that follows a broken rule now gets two more checks, and if either doubts it, the plan goes back to the agent. On plans nobody read while writing the checks, they caught 7 of 8 harmful plans and sent back 2 of 12 good ones.

**Containment, checked from outside the sandbox.** 7 of 7 red-team attacks contained, checked from the host, with prod's hash unchanged. 23 attacks on the approval, the apply and the measurement were refused, rolled back or held, and 11 checks confirm the honest path still works. 50 rehearsals in a row left no sandbox behind.

**We attacked our own policy.** An attacker model told every guardrail and the auto-apply rule got 5 of 7 damaging plans past a row limit, with no person looking, so auto-apply now works from a named list. 5 of the same attacker's 7 damaging plans would still apply alone, but they can only change what the owner listed: feature_flags.note. What it finds becomes a candidate rule, which counts only if it holds on the clean database, fails on the attack and lets ordinary changes through. Replayed against the rules they taught, 7 of 7 of those attacks are now stopped, in a separate test with 17 rules.

**Built on Vultr, end to end.** Every LLM call goes to Vultr Serverless Inference, and the models never grade themselves: they propose plans, draft guardrails, explain results and read plans a second time, while Postgres measures and frozen checks decide. The microVMs run on a Vultr VX1, the control plane on Vultr Cloud Compute, prod is Vultr Managed PostgreSQL, evidence bundles and backups go to Vultr Object Storage, and the runner sits on a Vultr VPC behind a firewall group. One script creates all of it from zero and one removes it.

**Who pays.** Whoever owns the database at a team using coding agents. 90% of professional developers now use them weekly (JetBrains Developer Ecosystem Survey 2026). It starts free, as a pull request Action that can't touch prod, and then a subscription per protected database, with a self-hosted licence for regulated teams. Gartner expects guardian agents to take 10 to 15% of the agentic AI market by 2030. Migration linters read the statement, and thin clones like DBLab and Neon give a copy. An approval bound to the measured result of the exact plan, with an apply that rolls back if prod differs. None of the docs above describe that. Where it's weak: full restores get slow on large databases, it covers Postgres and Linux hosts only, and it has no customers yet.

**Try it.** https://144-202-92-64.sslip.io: press Race the agent to watch the same task run alone and through Shadow Run, side by side, or Continue as guest to request, approve, break and undo a change yourself. It also ships as an MCP server (shown with OpenCode on Vultr inference), a CLI and a GitHub Action that posts what a migration really does on the pull request.

## Long description, shorter

Use this one if the form's limit is lower than the version above.

AI agents with real access keep destroying production data with one command. Shadow Run sits between an agent and prod and holds the only credential. Every risky plan is frozen, hashed and run on a full clone of prod in a fresh Microsandbox microVM on Vultr, with no network device and no secrets. Postgres reports what really happened, frozen guardrails check it, and failures go back to the agent to rewrite the plan. A different person approves those exact hashes, and the same plan runs on prod in one transaction that rolls back if anything differs from the rehearsal.

- 0 of 23 held-out risky tasks did harm on prod before a person saw the plan. The same agent alone did harm on 9.67. Nothing that changed anything went through without a person: 17.33 of 23 risky plans waited, which is where the zero comes from (bench/results.json).
- Approved unread, harm went from 9.67 to 2, and that holds task by task (95% CI -12 to -3.67, p = 0.0078). Work done: 11.33 alone, 11.33 through Shadow Run, which this sample can't separate (p = 1). (bench/stats.json)
- Rules in the prompt cut harm about as much: 3 against Shadow Run's 2 on 19 SQL tasks, which this sample can't separate. The difference is when it lands: a prompt's plan runs on prod with nobody looking.
- Told which rule it broke, the agent sometimes gets around it. Plans that passed only after breaking a rule were harmful 35% of the time, against 13% for first-time passes. A measured check and a second model now send those plans back: 7 of 8 harmful caught on plans neither had seen, 2 of 12 good sent back by mistake (bench/evasion.json).
- 7 of 7 live attacks contained, each in a microVM with no network card, checked from the host, with prod’s hash unchanged (bench/redteam.json).
- On Vultr end to end: The final benchmark spent 9,549,968 tokens of Serverless Inference across 4 models ($3.79), booted 1,219 microVMs on one VX1, created and dropped 1,008 databases on Managed PostgreSQL over the VPC, and Object Storage holds 138 evidence bundles and pre-apply backups. Spent so far: $26.21 of the $200 credit (bench/vultr.json).

Every LLM call goes to Vultr Serverless Inference, on VX1, Cloud Compute, Managed PostgreSQL, Object Storage and a VPC. It ships as a web app, an MCP server, a CLI and a GitHub Action.

## Tags

AI agents, MCP, sandbox, microVM, Postgres, Vultr, security, DevOps, guardrails, human in the loop

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
