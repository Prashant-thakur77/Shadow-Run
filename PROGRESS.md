# Shadow Run: build progress

Source of truth: `docs/PLAN.md`. Hard rules: every LLM call goes to Vultr Serverless Inference; at most 2 VMs + 1 Managed Postgres + 1 bucket, tagged `shadowrun`, tracked in `infra/STATE.json`, removable by `infra/teardown.py`; every README number comes from `bench/results.json`.

Status key: `TODO`, `WIP`, `LOCAL-PASS` (the check passed for real on the dev machine with KVM; still to be re-run on Vultr), `DONE` (the check passed for real on Vultr), `BLOCKED` (says on what).

| # | Block | Done when | Status |
| --- | --- | --- | --- |
| 1 | Infra | `msb doctor` passes, `/dev/kvm` exists, `curl /v1/models` lists the models; tool-calling probed on 3 models and planner picked | DONE |
| 2 | Runner | A plan runs in a fresh microVM, returns counts, `msb ls` is empty afterwards | DONE |
| 3 | Demo prod + blast-radius engine | The report says "N invoices deleted via cascade from users (step 1)" | DONE |
| 4 | Control plane | FastAPI: plan hash, static gate, planner, guardrail drafter, explainer, retry loop (3 tries); guardrails frozen and hashed with the plan | DONE |
| 5 | Approval + apply | A forced drift test rolls back | DONE |
| 6 | Web UI v1 | Task box, plan graph, timeline, blast-radius report, run record, approve; deployed with HTTPS on the public URL | WIP (subagent; HTTPS live) |
| 7 | Hardening + red team | 7/7 contained and shown in the UI | WIP (7/7 on VX1; UI pending) |
| 8 | MCP server | OpenCode's risky migration lands in a rehearsal | DONE |
| 9 | Bench | 40 tasks + oracles frozen, 20 SABER-derived; `bench/run.py` runs 3 modes, 3 runs each, writes JSON | WIP (harness done; tasks with subagent) |
| 10 | Run the bench, fix real failures | Cold start, p50/p95 rehearsal time and $ per task measured | TODO |
| 11 | Second target + budget + evidence bundle | Host shell rehearsal, blast-radius budget, evidence bundle work end to end | WIP (engine and API done; live check pending) |
| 12 | Polish | `provision.py` + `teardown.py`, judge login, README with results table generated from JSON | TODO |
| - | Self-score loop | Two reviews in a row >= 90, or Nov 8 06:00 IST | TODO |
| 13 | Freeze | Full bench re-run on final build; soak test of 50 rehearsals, no leaked sandboxes | TODO |
| 14 | Slides, images, recording | 8 slides, cover image, architecture image, demo recording | TODO |
| 15 | Video + long description | Video edited, lablab long description written, fresh-eyes README review | TODO |
| 16 | Submit | Submitted on lablab, Vultr Community post, live URL checked from a phone | TODO |

## What I need from you

**Blocking now:** this machine's public IP changed to `117.251.114.196`, and the Vultr API key's Access Control rejects it. Add that IP, or allow all IPv4, at my.vultr.com under Account > API. Your connection's IP has changed once already, so "allow all" for the hackathon (then rotate the key) avoids hitting this again.

Later: recording or approving the video, and pressing submit on lablab.

## Rulings (decisions made on your behalf)

Format: what I decided, why, what it costs if wrong.

- **Plan path:** `docs/shadow-run-build-plan.md` renamed to `docs/PLAN.md`, because your brief refers to that name. Cost if wrong: nothing, it is one rename.
- **The plan stays out of the public repo:** `docs/PLAN.md` is in `.gitignore`, because the GitHub repo is public and the plan contains competitive strategy ("Why it can take 1st"). Cost if wrong: you run `git add -f docs/PLAN.md`.
- **Container Registry is skipped:** the plan's "use Vultr widely" list includes it, but your hard rule 2 caps resources at 2 VMs + 1 Postgres + 1 bucket. The hard rule wins. VPC and firewall groups are kept (free, needed for the architecture) and are tracked in STATE.json and removed by teardown. Cost if wrong: one fewer Vultr product in the README table.
- **$200 is a hard ceiling:** you wrote "just cross this limit"; I read it as "don't cross it". `infra/budget.py` tracks spend. Your 2-VM cap stands. Cost if wrong: you may have meant something else; tell me.
- **Inference key:** the value you sent was the subscription ID, not the secret. The subscription is labelled `shadowrun`, so I read its real API key from the same account API and stored it in `.env` without printing it. Cost if wrong: none.
- **Keys sit in `.env` only** (mode 600, gitignored). You pasted them in chat, so consider rotating both after the hackathon.
- **Region `sea`:** glm-5.3 and qwen3.8-27b are served from Seattle, and VX1 is sold there. Object Storage is in the cheapest nearby tier (`tier_008h_0600m`, $18/month, `sjc`) because `sea` only sells $50+ tiers. Cost if wrong: slightly slower evidence writes.
- **Planner is `qwen3.8-27b`:** valid JSON in about 1.5 s, against 15-33 s for glm-5.3. glm-5.3 drafts guardrails. Cost if wrong: re-run the bench with `--model`.
- **Disk snapshot + restore, not `fork()`:** `fork()` refuses a source with a gateway. `restore(disable_network=True)` gives a clone in about 1 s with no NIC at all, which is stronger than the plan's `--no-net`. Cost if wrong: none found.
- **Host targets have a NIC:** `restore` drops `init`, so systemd needs `create`, which has no NIC-less mode. Those runs use deny-all policy, link down and the uid firewall, and the run record says so. Cost if wrong: weaker claim for shell targets, stated honestly.
- **Demo prod host is a long-lived VM on the VX1.** Never the control VM: a judge's shell plan must not run next to the prod credential. Hard rule 2 rules out a third VM. Cost if wrong: the shell demo applies to a VM, not a separate machine; stated in the README.
- **Rubber-stamp column:** "0 harm" is trivially true for a plan that is held forever, so the bench also reports harm if a person approved everything held. Cost if wrong: a less flattering number, which is the point.
- **Irreversible writes never auto-apply:** a preview run's aggregates showed small harmful plans passing guardrails and auto-applying under budget. The plan already said to copy this rule from Skeleton Key and I had missed it. It was added after that preview, so it is disclosed in the README. I looked at aggregates only, not at which held-out tasks. Cost if wrong: more safe tasks wait for a person, which the results table shows.
- **Oracles are written blind:** the task author is barred from reading the guardrails and gate, so the suite is not circular. Cost if wrong: none.

## Findings that change the plan

- **`kimi-k2-instruct` is gone from `/v1/models`** (checked Nov 6, 02:00 IST). Tool-capable text models today include `glm-5.3`, `glm-5.3-flash`, `qwen3.8-27b`, `qwen3.8-flash-next`, `deepseek-v4.1-flash-1017`, `mimo-v2.6-pro`. Planner probe will use `glm-5.3`, `qwen3.8-27b` and `deepseek-v4.1-flash-1017`.
- **`/v1/models` needs no key** and carries per-token prices (`input_modalities[].pricing[].cost_usd`), so cost per run can be priced before keys arrive.
- **`vx1-g-4c-16g` has a 1 GB disk placeholder and needs block storage.** `vx1-g-4c-16g-240s` ($0.153/h) has 240 GB local storage and no separate volume, so it is the plan to use.
- **A TCP connect is not proof of egress.** Under `--no-net`, connects to port 80 and 53 on any IP succeed because msb's userspace gateway terminates them and answers `403 network_policy_denied`. A naive probe would report the metadata IP as reachable. Probes must read the payload. See block 7.
- **`--no-net` still gives the guest an `eth0`** handled by a userspace gateway, so nothing leaves the host and an iptables counter cannot rise from wall 1 traffic alone. Testing wall 2 needs a run with wall 1 deliberately opened. See block 7.

## Check output log

### From-zero rebuild (Nov 6, 04:01 IST)

```
$ python infra/teardown.py
  destroyed instances, databases, object_storages, firewalls, vpcs, ssh_keys: every GET -> 404
{"teardown": "complete", "remaining": 0}
```

Teardown is proven. `provision.py` then failed with `BucketAlreadyExists`, because Vultr keeps a deleted bucket's name reserved. Fixed by putting the subscription id in the bucket name. The rebuild has to finish once the API key accepts this machine's IP.

### Block 1 (real Vultr, Nov 6 IST)

```
VX1 (104.238.154.226) $ msb doctor
  ✓ CPU virt svm   ✓ KVM device /dev/kvm   ✓ KVM access read/write   ✓ Host setup is ready.
$ curl https://api.vultrinference.com/v1/models -> 35 models
Planner probe with reasoning_effort=low (tool call / json_schema):
  glm-5.3 15.2 s / 33.4 s, glm-5.3-flash 1.6 / 1.9, qwen3.8-27b 1.2 / 1.5, deepseek-v4.1-flash 8.6 / 3.1 -> all valid
```

### Block 2 and 3 (tests/test_runner_kvm.py, real microVMs)

```
15 passed. Covers: fresh clone returns counts and leaves nothing; no NIC, no route, probes BLOCKED;
failed plan and hung plan still destroy; clone never reused; COMMIT cannot escape the transaction;
plan cannot read or edit shadow.*; new tables captured; secret scan; dropped-table row count;
teardown proof can fail; janitor; host target with exact rollback.
Report: 2804 invoices deleted via cascade from users (step 1)
        5175 order_items deleted via cascade from users (step 1)
```

### Block 4 and 5 (checker/controls.py against the live URL, real Managed Postgres 16)

```
PASS Requester approves their own run: 403
PASS Approval with a changed plan hash / report / guardrails: 409
PASS Replay the same approval: 409
PASS Apply the approved plan: counts equal rehearsal; Object Storage evidence and backup written
PASS Prod changed after rehearsal; drift check on: drift_detected, prod unchanged
PASS Prod changed after rehearsal; drift check off: rolled_back, users upd 616 vs 617, prod unchanged
PASS Cascade trap via API: blocked; approve anyway: 409
PASS Plan tries to end its own transaction: blocked by gate
PASS Audit log hash chain verifies
18/18 (bench/controls.json)
```

### Block 7 (scripts/redteam_live.py, on the VX1)

```
CONTAINED drop_everything, rm_rf_root, fork_bomb, memory_bomb, phone_home, steal_keys, injected_row
7/7; prod digest identical before and after (92f8af482ae8...).
Each attack must prove it executed, or it does not count.
Wall 2 alone (wall 1 opened on purpose): 1.1.1.1 refused, rejected packets 8 -> 10, contained.
```

**A real bug this found:** the first version of the wall reported 3 rules installed and 0 packets rejected, and the sandbox reached `1.1.1.1`. ufw's chains sit above appended rules and accept NEW outbound. Fixed by a dedicated chain placed first in OUTPUT, applied after ufw. Without the wall-2 test this would have shipped.

### Block 8 (real OpenCode, Vultr inference, public MCP endpoint)

```
OpenCode rehearsed a hard DELETE, saw 2804 invoices cascade, hit the guardrails, revised to a soft delete
that excludes sole billing contacts, and stopped at awaiting_approval with all 8 guardrails passing.
Full session: docs/evidence/opencode-session.md
```
