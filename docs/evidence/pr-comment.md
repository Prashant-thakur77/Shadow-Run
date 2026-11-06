# What the GitHub Action posts on a pull request

The text this bad migration produced on the live build, with the command the Action runs: `shadowrun rehearse plan.sql --rehearse-only --markdown`. Prod's hash was the same before and after. The workflow itself has not yet run on GitHub.

```sql
DELETE FROM users WHERE last_login_at < now() - interval '1 year';
```

### Shadow Run: Blocked

Rehearsed on a disposable clone of prod in a microVM. [Full report](https://144-202-92-64.sslip.io/runs/r0f68d7abbc4c4f), plan `b9ec878fefda`.

This was a rehearsal only. Nothing reached prod.

**A guardrail failed on the clone. Guardrails are frozen and cannot be approved past.**

| Measured by Postgres |
| --- |
| 5175 order_items deleted via cascade from users (step 1) |
| 2804 invoices deleted via cascade from users (step 1) |
| 2704 payments updated via cascade from users (step 1) |
| 2064 orders deleted via cascade from users (step 1) |
| 689 sessions deleted via cascade from users (step 1) |
| 186 support_tickets updated via cascade from users (step 1) |
| 1197 users deleted directly (step 1) |

| Business metric | Before | After |
| --- | ---: | ---: |
| Paid invoices on record | 2834782.0 | 1794086.0 |
| Customer order history | 16227197.96 | 12267549.43 |
| Live users | 5129.0 | 3960.0 |

Guardrails: 4 of 10 passed.
- Failed: No paid invoice is lost
- Failed: Total paid revenue is unchanged
- Failed: No payment loses its invoice
- Failed: Every active account keeps a live billing contact
- Failed: No customer order is lost
- Failed: Users are retired with deleted_at, never deleted

