# Demo script (3:00)

Recorded against the live URL at 125% browser zoom, one take for the red team. Numbers on screen are whatever the run measures. Don't quote numbers in the voice-over that aren't on screen.

| Time | On screen | Voice-over |
| --- | --- | --- |
| 0:00-0:12 | PocketOS headline, DataTalks post-mortem, "9 seconds" | In April an AI agent deleted a company's production database and its backups in nine seconds. It isn't the only one. |
| 0:12-0:20 | Title: Shadow Run. "Your agent wants to touch prod. Shadow Run lets it break a clone first." | |
| 0:20-0:45 | Home: click "Archive users who have been inactive for over a year". Status moves through snapshotting, planning, rehearsing. Rehearsal bar fills in. | The agent writes the plan. Shadow Run hashes it and runs that exact plan on a clone of prod, inside a throwaway microVM on Vultr with no network device. |
| 0:45-1:05 | Attempt 1: blast radius goes red, cascade graph from users, guardrails failing. | The plan says delete inactive users. Postgres says what that really means: paid invoices and customer orders gone, by cascade. The frozen guardrails fail, and the agent can't edit them. |
| 1:05-1:20 | Attempt 2 or 3: soft delete, zero cascades, guardrails green. | The measurements go back to the agent. It rewrites the plan and rehearses again, on a new clone. |
| 1:20-1:45 | Red team page: Run the red team. DROP DATABASE, rm -rf /, fork bomb, curl prod. Cards turn green. Second wall counter rises. Prod untouched card with identical hashes. | Even if the agent goes rogue, only the clone dies, and every check here is made from the host, not from inside the sandbox. |
| 1:45-2:05 | Back on the run: as judge, approve is refused (403). Tamper the hash (409). Switch to reviewer, approve, apply: committed, counts match. Then a second run: change prod behind its back, apply, drift detected. | The person who asked can't approve it, and approval binds to these exact hashes. Prod only runs the approved plan, and only if it matches the rehearsal. |
| 2:05-2:20 | Terminal: OpenCode on Vultr inference, `shadowrun` as an MCP server, no database credentials. A risky migration lands in a rehearsal. | It drops into agents teams already use, through MCP. |
| 2:20-2:40 | Results page: three-column table. | Same agent, same prompt, same database. Read the headline row and the rubber-stamp row. |
| 2:40-3:00 | Architecture image, Vultr product table, evidence bundle in Object Storage. | VX1 microVMs, Serverless Inference, Managed Postgres, Object Storage, a VPC. Every number here comes from a script in the repo. |

Before recording: `POST /api/demo/reset`. Keep the UI on the dark theme. Have `reviewer` signed in on the same tab, so the switch is one click.

## Q&A facts

Isn't this DryRun? DryRun rehearses in Docker on sampled rows and gives advice, and the agent still runs the real action. Shadow Run clones the whole database in a microVM and enforces the result with a hash-pinned apply that rolls back.

Why not just a read-only role or a code review? Neither tells you what a statement will really do. A `DELETE` with a good-looking `WHERE` is exactly what cascades.

What can it not do? Outside side effects can't be rehearsed, so they go to a person. Clone cost grows with database size. PII isn't masked yet. See Limits in the README.

Why not trust the model's own check? The model never grades itself. Row counts come from Postgres, and guardrails are SQL it can't edit.
