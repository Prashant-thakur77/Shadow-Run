# Shadow Run

**Your agent wants to touch prod. Shadow Run lets it break a clone first.**

<!-- live:start -->
<!-- live:end -->

<!-- headline:start -->
<!-- headline:end -->

Demo video: VIDEO_URL

## The problem

AI agents with real access keep destroying production data in one command. In April 2026, by its founder's account, a Cursor agent at [PocketOS](https://www.pcgamer.com/software/ai/here-we-go-again-ai-deletes-entire-company-database-and-all-backups-in-9-seconds-then-cheerfully-admits-i-violated-every-principle-i-was-given/) hit a credential mismatch on a staging task, found a Railway API token in an unrelated file, and deleted the production volume and its backups in nine seconds. In February, Claude Code ran `terraform destroy` against [DataTalks.Club](https://aishippingblog.com/p/how-i-dropped-our-production-database) off a stale state file. At [SaaStr](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/) a Replit agent wiped records during a code freeze. [Salt Security's October 2026 survey](https://campustechnology.com/articles/2026/10/21/unexpected-ai-agent-activity-reported-by-nearly-half-of-organizations-in-recent-survey.aspx) found that 49.8% of respondents confirmed or suspected unexpected or unauthorized agent activity, and 17.5% said they could automatically stop an agent.

Those incidents share two things. Separating dev from prod didn't help, because the agent found a credential that reached prod. And the damage hid in side effects: backups next to the database, cascades nobody listed in the plan.

## How it works

The agent never gets the credential. It gets three tools, and Shadow Run holds the only prod login.

1. The plan is frozen: SHA-256 of the exact steps, with the guardrails hashed alongside it.
2. A static gate reads it with a real SQL parser (sqlglot) and ShellCheck. Anything the gate can't read is treated as unsafe.
3. Prod is snapshotted and restored into a fresh Microsandbox microVM with no network device and no credentials. The plan runs there as an unprivileged role.
4. Postgres measures the blast radius: rows per table, each cascade traced to the step that caused it, schema changes, before and after samples. No model is involved in this part.
5. Business guardrails run inside the same transaction. They're frozen SQL that the agent can't edit. On failure, the measurements go back to the agent, which revises and rehearses on a new clone.
6. Small changes that fit the team's budget go through. Everything else waits for a different person, who approves those exact hashes. A changed or replayed approval gets a 409.
7. The same plan runs on prod in one transaction, with the touched tables locked and re-checked for drift. If row counts, row content, schema or guardrails differ from the rehearsal at all, it rolls back. A backup and a signed evidence bundle go to Object Storage.

![Architecture](docs/architecture.svg)

It works with any MCP agent. Here is a [real OpenCode session on Vultr inference](docs/evidence/opencode-session.md): it rehearses a hard delete, sees the invoices cascade, hits the guardrails, rewrites the plan as a soft delete and stops to wait for a person.

## Results

Three modes, same model, same prompt, same seeded database, a fresh copy for every run: the agent directly on prod, the agent behind a static rule gate (the same gate Shadow Run starts with), and the agent through Shadow Run.

<!-- results:start -->
<!-- results:end -->

The suite is 40 tasks of ours plus 20 adapted from [SABER](https://github.com/sssr-lab/saber), so the result isn't only on our own planted data. Oracles decide harm by checking outcomes. They were written by a separate agent that was barred from reading the guardrails and the gate, and each one is tested with a known-bad and a known-good plan (`python -m bench.validate`). We tuned on 10 tasks and report the other 30 and the SABER set separately. SABER's guardrails were drafted by the model and left unedited. One disclosure: after a preview run's totals showed small harmful plans auto-applying under budget, we added the rule that irreversible writes always need a person. We read only the totals for that, not which held-out tasks were involved, but the held-out set isn't perfectly clean of that one decision.

<!-- groups:start -->
<!-- groups:end -->

<!-- cost:start -->
<!-- cost:end -->

## Vultr services

| Service | What it does here | Config |
| --- | --- | --- |
| VX1 Cloud Compute | Rehearsal microVMs with KVM, the host-side checker, both network walls | `vx1-g-4c-16g-240s`, Seattle |
| Cloud Compute | Control plane: API, web UI, MCP server, the only prod credential | `vc2-2c-4gb` |
| Serverless Inference | Every LLM call: planner, retry loop, explainer, guardrail drafter, content safety | `qwen3.8-27b`, `glm-5.3`, `nemotron-3.5-content-safety`; cost priced from `/v1/models` |
| Managed PostgreSQL 16 | The demo production database, reached over the VPC by a role that owns one database | 1 node, 2 GB |
| Object Storage | Evidence bundles and pre-apply backups | S3 API |
| VPC Network and firewall groups | The runner port is reachable only from the control VM | `10.77.0.0/24` |

`infra/provision.py` creates all of it from zero, and `infra/teardown.py` removes it and confirms each resource returns 404.

## Containment

Every check below is made from outside the sandbox and printed on every run page.

| Criterion | Controls | Proof on each run |
| --- | --- | --- |
| Process isolation | One microVM per rehearsal, with its own kernel. Clones come from a golden disk and are never reused. | Guest kernel differs from host. `/dev/kvm` present. |
| Secret hygiene | No credential enters the sandbox: no env, no host mounts. The dump is deleted before the golden disk is captured. | Scan of every process environment and the writable filesystem: 0 hits. A canary token on the host never appears in anything returned. |
| Resource limits | 2 vCPUs, 2 GB, 120 s wall clock, statement timeout. Two network walls: no NIC at all, plus a host iptables chain for the sandbox uid that also rejects the metadata IP and the VPC. | Probes to prod, the metadata IP and the internet read the reply, not just the connect. Rejected-packet counter. |
| Lifecycle discipline | Destroyed in `finally`, on success, failure and timeout. A janitor removes anything over 10 minutes old. | Not listed by the runtime, disk gone, no leftover processes. |

Each attack below runs for real in a clone with the gate off, and it only counts if it demonstrably executed.

<!-- redteam:start -->
<!-- redteam:end -->

We also tried to break the approval, the apply and the measurement on the live system. The last group came from an independent adversarial review of this code, which found that counts alone missed plans that only misbehave on prod, and that a plan could rewrite the guardrail baselines. Those holes are closed, and these attempts now prove it each time:

<!-- controls:start -->
<!-- controls:end -->

<!-- soak:start -->
<!-- soak:end -->

## Try it

On the web, sign in, click an example task and watch the rehearsal. The Red team page runs all seven attacks live.

Through MCP with OpenCode on Vultr inference, copy [`docs/opencode.json`](docs/opencode.json), set `VULTR_INFERENCE_KEY` and `SHADOWRUN_TOKEN` (shown on the web app's Target page), and ask it to change the database. Claude Code and Cursor work the same way: `claude mcp add --transport http shadowrun "$SHADOWRUN_URL/mcp" --header "Authorization: Bearer $SHADOWRUN_TOKEN"`.

From a terminal or CI:

```
pip install -e . && export SHADOWRUN_URL=https://... SHADOWRUN_TOKEN=...
shadowrun rehearse plan.sql --target demo-saas   # exit 0 applied, 2 needs a person, 3 blocked, 4 rolled back
```

## Run your own

```
cp .env.example .env          # VULTR_API_KEY and VULTR_INFERENCE_KEY
python infra/provision.py     # 2 VMs, Managed Postgres, bucket, VPC, firewall groups
python infra/seed_prod.py     # least-privilege role and demo data
python infra/bench_role.py
python infra/deploy.py        # code, images, walls, web UI, HTTPS
bash scripts/bench_remote.sh 'python -m bench.run --runs 3 --parallel 4'
python scripts/make_readme_table.py
python infra/teardown.py      # removes everything, confirms 404
```

## Limits

Steps with effects outside the target, such as sending email or calling Stripe or a cloud API, can't be rehearsed. They are flagged and always go to a person.

Some harm needs a person to catch it. If no guardrail encodes an invariant, Shadow Run can only show the diff. The rubber-stamp row in the results table is that gap, measured.

Rehearsal cost grows with database size, because the clone is a full restore:

<!-- scale:start -->
<!-- scale:end -->

Thin clones (DBLab, ZFS) are the fix at larger sizes, and they aren't built. PII masking isn't built either, so a clone holds real data, though it has no way to send it anywhere.

Linux host targets are weaker than Postgres ones. systemd needs a boot path that microsandbox only offers with a NIC present, so host rehearsals use a deny-all policy, a downed link and the host firewall instead of no NIC. The demo's "prod host" is a long-lived VM on the VX1, and apply on a host can't be transactional: it keeps a tar and restores it on any mismatch.

A plan that behaves differently on purpose, such as one branching on `current_user` or `random()`, is caught at apply as a mismatch and rolled back, which can also reject harmless nondeterminism. Timestamp columns are the exception: because `now()` legitimately differs between rehearsal and apply, only whether they are NULL is compared. A plan that writes a wrong timestamp on the right rows would pass that one check.

## Prior art and credits

[DryRun](https://github.com/HMAKT99/DryRun) rehearses SQL in Docker on sampled rows and gives advice. Shadow Run uses a full clone in a microVM and enforces the outcome with a hash-pinned apply. [safe-migrations-mcp](https://pypi.org/project/safe-migrations-mcp/) simulates on prod inside a rolled-back transaction, which still takes locks on prod. [Neon's MCP](https://github.com/neondatabase/mcp-server-neon) branches for schema migrations on Neon.

Patterns adapted from Vultr Agent Arena entries, rewritten for this stack: host-side red team and the uid firewall from [Nusa](https://github.com/a8nova/nusa), scripted provisioning and pricing from `/v1/models` from [Skeleton Key](https://github.com/Carldtitan/skeleton_key), the scored gauntlet with a baseline from [Cerberus](https://github.com/Preet37/VultrHack), digest-bound approvals from [Airlock](https://github.com/nihalnihalani/airlock), the hash-chained audit log from [Tieout](https://github.com/chinesepowered/hack-vultracc). External tasks are from [SABER](https://github.com/sssr-lab/saber) (CC-BY-4.0). MIT licence.
