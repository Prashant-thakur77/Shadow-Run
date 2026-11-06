# Shadow Run API

Base URL: the public URL (see `infra/STATE.json` -> `public_url`, or `SHADOWRUN_URL`). JSON everywhere.

**Auth.** `POST /api/login {username, password}` returns `{username, name, token}` and sets an httpOnly cookie. Send either the cookie or `Authorization: Bearer <token>`. `GET /api/me` returns `{username, name, role, token}`. There are two public demo users: `judge` (role requester) and `reviewer` (role approver). `401` means not signed in.

## Runs

| Method and path | Purpose |
| --- | --- |
| `POST /api/runs {target_id?, task?, steps?, source?}` | Start a run. `task` is plain English for the built-in agent. `steps` is `[{type:"sql", cmd, why?}]` and skips the agent. Returns `201 {id, status}`. `429` when over the hourly limit. |
| `GET /api/runs?limit=` | Summaries, newest first: `{id, created_at, status, requester, task, source, target_id, plan_hash, attempts, rows_changed, rows_via_cascade, guardrails_failed, cost_usd, rehearsal_ms}`. |
| `GET /api/runs/{id}` | Full run. Poll about once a second until a terminal status. |
| `POST /api/runs/{id}/approve {plan_hash, guardrails_hash, report_hash, nonce}` | Send back exactly the values in `run.challenge`. `403` requester cannot approve own run. `409` a value differs or the run was already decided. `410` the approval window expired. |
| `POST /api/runs/{id}/reject {reason}` | Reject. |
| `POST /api/runs/{id}/apply {drift_check?: true}` | Apply an approved run. `drift_check:false` turns off the first line of defence, to demonstrate the rollback. `409` if not approved or already used. |
| `POST /api/runs/{id}/rehearse-again` | New run with the same plan on a new snapshot. Returns `201 {id, status}`. |
| `GET /api/runs/{id}/evidence` | The evidence bundle JSON. |
| `POST /api/check {target_id?, steps}` | Static gate only: `{plan_hash, gate}`. |

**Run status values.** In progress: `queued`, `snapshotting`, `planning`, `rehearsing`, `applying`. Waiting: `awaiting_approval`, `approved`. Finished: `blocked`, `applied`, `rolled_back`, `rejected`, `drift_detected`, `no_change`, `error`. `no_change` means the rehearsal changed nothing, so nothing reached prod.

**Fields of a full run** (see `web/fixtures/run-*.json` for real examples, captured from the live system):

- `id, status, requester, source, task, target_id, created_at, updated_at, error, blocked_reason`
- `can: {approve, approve_blocked_reason, apply, rehearse_again}`: computed by the server for the signed-in user. Trust this, do not re-derive it.
- `challenge: {run_id, plan_hash, guardrails_hash, report_hash, nonce, expires_at}`: only while `awaiting_approval`.
- `timeline: [{t, type, actor, detail, seq}]`: event types include `run_created, snapshot_taken, injected_text_flagged, planning, agent_reads, plan_frozen, static_gate, rehearsal_started, rehearsal_finished, guardrails_checked, run_blocked, awaiting_approval, auto_approved_within_budget, approved, rejected, apply_started, backup_written, apply_committed, apply_rolled_back, apply_drift_detected, evidence_written`.
- `attempts: [attempt]`, `final_attempt`, and `final` (the last attempt, for convenience).
- `plan_hash, guardrails_hash, report_hash, guardrails: [{id, name, sql, why, accepted_by}]`
- `data_flags: [{table, column, preview, model, verdict, raw}]`: stored text that reads like instructions, judged by Vultr's content-safety model. `verdict` is `unsafe` or `safe`.
- `snapshot: {snapshot_id, lsn, digest, cached, tables, timing, bytes, server_version}`
- `approval: {approver_id, kind: human|auto_budget, plan_hash, signature, granted_at, ...}`, `rejection`
- `apply: {outcome: committed|drift_detected|rolled_back, reason, expected_counts, actual_counts, count_mismatches, drifted_tables, schema_matches, guardrails, steps, ms}`
- `prod_check: {before, after, unchanged, measured_from}`: prod's hash before and after the rehearsal, measured outside the sandbox. Worth showing as a "Prod untouched" line on the run page.
- `backup`, `evidence: {store, bucket, key, bytes, bundle_sha256}`, `evidence_url` (presigned), `prod_after`
- `usage: [{phase, model, prompt_tokens, completion_tokens, cost_usd, seconds}]`, `cost_usd`
- `rerun`: a curl command that repeats this exact plan.

**An attempt:**

- `n`, `verdict`: `passed | failed_guardrails | blocked_by_gate | sql_error | sandbox_error | invalid_plan`, and `error`
- `plan: {steps: [{type, cmd, why, statements}], summary}`, `plan_hash`, `guardrails_hash`, `report_hash`
- `gate: {verdict: pass|review|block, flagged, findings: [{step, statement, rule, severity: block|high|review, reason}], steps: [{step, risk: read|reversible_write|irreversible_write}], highest_risk}`
- `guardrails: [{id, name, passed, violations, violation_count_capped, error, ms}]`
- `budget: {within, reasons, limits}`
- `explanation: {text, numbers_verified, unverified_numbers, note}`: model commentary. A deterministic check flags any number the model stated that is not in the measurements. Show that flag.
- `report`: the blast radius, measured in the clone:
  - `totals: {rows_inserted, rows_updated, rows_deleted, rows_changed, rows_via_cascade, tables_touched, tables_dropped, tables_truncated, ddl_commands}`
  - `tables: [{table, rows_before, rows_after, inserted, updated, deleted, direct, cascade, pct_of_table, dropped, truncated, via}]`
  - `sentences: [{step, table, op, rows, via: direct|cascade, path, text}]`: already sorted, cascades first.
  - `cascade_graph: {nodes: [{table, deleted, updated, direct, cascade}], edges: [{from, to, on_delete, rows}]}`
  - `samples: {table: {DELETE|UPDATE|INSERT: [{before, after}]}}`, up to 5 rows.
  - `ddl: [{step, tag, object_type, identity}]`, `schema_diff: [{kind, name, change}]`, `xact_counts`, `capture_gaps` (non-empty means the row log missed changes Postgres counted; show it loudly)
- `rehearsal`: the run record:
  - `sandbox`, `limits: {cpus, memory_mib, max_duration_s, network}`
  - `host: {kernel, hostname, kvm_device, kvm_rw}`, `guest: {kernel, hostname}`, `image: {reference, digest}`
  - `probes: {ok, nics, routes, targets: [{label, host, port, result, how}], dns}`
  - `secret_scan: {ok, scanned, hits}`
  - `teardown: {sandbox_listed, rootfs_exists, leftover_processes, ok}`
  - `phases: {clone_boot_ms, first_exec_ms, probe_ms, execute_ms, secret_scan_ms, destroy_ms, total_ms}`
  - `contained` (bool), `metrics`, `sandbox_error`, `result` (raw measurements; do not render)

Host targets (`GET /api/targets` lists `demo-host` with `kind: "host"`): `report.kind` is `"host"`, and the report carries `totals: {files_created, files_deleted, files_changed, bytes_freed, services_stopped, ports_closed}`, `sentences` (same shape), `deleted_by_directory: [{path, files}]`, `files: {created, deleted, changed, counts, bytes_freed}`, `services_stopped`, `services_started`, `ports_closed`, with `tables` and `cascade_graph` empty. `rehearsal.boot_state` is the systemd state. The host path has a NIC present with a deny-all policy, and `limits.network` says so; show that text as it is. Steps are `{type: "shell", cmd}`, and a guardrail is `{id, name, sh}` instead of `sql`.

## Proof and demo controls

| Method and path | Purpose |
| --- | --- |
| `GET /api/prod-checksum` | `{digest, lsn, rows: {table: n}, at}`. Hash of prod, measured from the control plane. |
| `POST /api/demo/drift` | Writes one row directly to demo prod behind Shadow Run's back: `{inserted_user_id, what}`. |
| `POST /api/demo/reset` | Reseeds demo prod. |
| `POST /api/redteam` | Starts the 7 attacks, or returns the one already running. |
| `GET /api/redteam?limit=` | Newest first: `{id, status: running|done|error, expected, attacks: [...], prod_before, prod_after, prod_unchanged, contained, total, wall_two, created_at}`. Poll while running. |
| `GET /api/redteam/attacks` | `[{id, title, expected}]`. |
| `GET /api/results` | Benchmark results (public, no login). `{"status": "not measured yet"}` until the benchmark has run. Never show a number that is not in this response. |
| `GET /api/audit?after=&limit=` | `{events: [{seq, run_id, ts, actor, type, detail, prev_sha256, sha256}], chain: {ok, events, head}}`. |
| `GET /api/health` | Public. `{ok, s3, inference_base_is_vultr, planner_model, runner: {host, msb_doctor_ok, image_digest, firewall}}`. |
| `GET /api/targets`, `GET /api/targets/{id}` | `{id, name, kind, guardrails, guardrails_hash, budget, auto_apply_within_budget}`. |
| `GET /api/targets/{id}/inspect` | `{served_from: "clone", snapshot_id, tables: [{name, columns, row_count, sample_rows}], foreign_keys: [{child, parent, constraint, on_delete}]}`. |
| `POST /api/targets/{id}/guardrails/draft` | The model drafts invariants: `{drafts: [{id, name, sql, why, holds_today, error}], model}`. Each draft has been tested on a clone. |

A red-team attack: `{attack, title, expected, contained, checks: [{check, ok, detail}], inside_output, wall_s, ended, exit_code, sandbox, host_before, host_after, firewall, sandbox_error, phases}`. `wall_two`: `{what, output, firewall_before, firewall_after, rejected_delta, reached_outside, contained, rootfs_gone}`.
