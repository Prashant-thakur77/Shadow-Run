# OpenCode on Vultr inference, routed through Shadow Run

A real `opencode run` session against the live MCP server, unedited apart from truncation. Model `vultr/qwen3.8-27b`. The agent has no database credentials, and bash, write and edit are disabled by [`docs/opencode.json`](../opencode.json). Recorded 2026-11-06 10:09 UTC. Re-run: `python scripts/record_opencode.py`.

Request: "Our users table has too many stale accounts. Run a migration on the demo-saas database that removes users who have not logged in for over a year."

**Tool `shadowrun_inspect`** (completed)

> I've reviewed the schema and found that the `users` table has `last_login_at`, and deletions will cascade through invoices, orders, and sessions, with support tickets set to null. Now I'll measure the blast radius on a clone to assess the impact.

**Tool `shadowrun_query`** (completed)
```sql
SELECT count(*) FILTER (WHERE last_login_at IS NULL) AS never_logged_in, count(*) FILTER (WHERE last_login_at IS NOT NULL AND last_login_at < now() - interval '1 year') AS stale_logged_in, count(*) FILTER (WHERE last_login_at IS NULL OR last_login_at < now() - interval '1 year') AS total_to_delete, count(*) FILTER (WHERE deleted_at IS NOT NULL AND (last_login_at IS NULL OR last_login_at < now() - [cut]
SELECT role, status, count(*) FROM users WHERE last_login_at IS NULL OR last_login_at < now() - interval '1 year' GROUP BY role, status ORDER BY role, status
SELECT (SELECT count(*) FROM invoices WHERE billing_user_id IN (SELECT id FROM users WHERE last_login_at IS NULL OR last_login_at < now() - interval '1 year')) AS invoices_cascade_deleted, (SELECT count(*) FROM orders WHERE user_id IN (SELECT id FROM users WHERE last_login_at IS NULL OR last_login_at < now() - interval '1 year')) AS orders_cascade_deleted, (SELECT count(*) FROM order_items oi JOIN [cut]
SELECT count(*) AS accounts_losing_all_users FROM accounts a WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id AND NOT (u.last_login_at IS NULL OR u.last_login_at < now() - interval '1 year'))
SELECT count(*) AS payments_losing_invoice_ref FROM payments p WHERE p.invoice_id IN (SELECT id FROM invoices WHERE billing_user_id IN (SELECT id FROM users WHERE last_login_at IS NULL OR last_login_at < now() - interval '1 year'))
```

> The clone is showing 1,197 stale users with cascades affecting invoices, orders, and order items, plus 62 accounts losing all their users. I'll run a rehearsal on a disposable clone to measure the exact impact before proceeding.

**Tool `shadowrun_rehearse`** (completed)
```sql
DELETE FROM users WHERE last_login_at < now() - interval '1 year'
```
Result: `blocked`
Blocked: A guardrail failed on the clone. Guardrails are frozen and cannot be approved past.
- measured: 5175 order_items deleted via cascade from users (step 1)
- measured: 2804 invoices deleted via cascade from users (step 1)
- measured: 2704 payments updated via cascade from users (step 1)
- measured: 2064 orders deleted via cascade from users (step 1)
- measured: 689 sessions deleted via cascade from users (step 1)
- measured: 186 support_tickets updated via cascade from users (step 1)
- measured: 1197 users deleted directly (step 1)
- guardrails failed: No paid invoice is lost, Total paid revenue is unchanged, No payment loses its invoice, Every active account keeps a live billing contact, No customer order is lost, Users are retired with deleted_at, never deleted

> The hard delete was rejected by the team's guardrails, which require users to be retired with `deleted_at` instead of deleted outright. I'll re-run the migration as a soft-delete to comply with the frozen rules.

**Tool `shadowrun_rehearse`** (completed)
```sql
UPDATE users SET deleted_at = now() WHERE last_login_at < now() - interval '1 year' AND deleted_at IS NULL
```
Result: `blocked`
Blocked: A guardrail failed on the clone. Guardrails are frozen and cannot be approved past.
- measured: 1169 users updated directly (step 1)
- guardrails failed: Every active account keeps a live billing contact

> I found that 1,169 users need to be retired, but the guardrail is blocking because retiring the billing user would break an active account. I'll identify exactly which accounts are affected and how to fix the dependency.

**Tool `shadowrun_query`** (completed)
```sql
SELECT count(*) AS active_accounts_losing_last_billing_role_user FROM accounts a WHERE a.status = 'active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id AND u.role IN ('billing','owner') AND u.deleted_at IS NULL AND u.last_login_at >= now() - interval '1 year')
SELECT count(*) AS retired_users_who_are_billing_or_owner_of_active_accounts FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.deleted_at IS NULL AND u.last_login_at < now() - interval '1 year' AND u.role IN ('billing','owner') AND a.status = 'active'
SELECT u.id, u.email, u.role, a.name AS account, (SELECT count(*) FROM users u2 WHERE u2.account_id = u.account_id AND u2.deleted_at IS NULL AND u2.last_login_at >= now() - interval '1 year' AND u2.role IN ('billing','owner')) AS other_live_billing_or_owner FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.deleted_at IS NULL AND u.last_login_at < now() - interval '1 year' AND u.role IN ( [cut]
SELECT count(*) AS active_accounts_with_no_live_user_at_all FROM accounts a WHERE a.status='active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id AND u.deleted_at IS NULL AND u.last_login_at >= now() - interval '1 year')
SELECT count(*) AS active_account_invoices_pointing_at_retired_billing_user FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE a.status='active' AND i.billing_user_id IN (SELECT id FROM users WHERE deleted_at IS NULL AND last_login_at < now() - interval '1 year')
```

> I found that 6 active accounts would lose their billing contact if we proceed, so I'll keep those 10 users as an exception. Now I'm checking their status to ensure the exception works regardless of how "live" is defined.

**Tool `shadowrun_query`** (completed)
```sql
SELECT a.name, u.id, u.role, u.status, u.deleted_at IS NOT NULL AS already_deleted, u.last_login_at FROM accounts a JOIN users u ON u.account_id = a.id WHERE a.name IN ('Hooli 152','Acme 167','Vandelay 212','Stark 224','Initech 265','Tyrell 271') ORDER BY a.name, u.id
```

> I found that 6 accounts have stale billing and owner users, with 10 affected users who are status-active. I'll keep these 10 users as an exception to ensure every active account maintains a live billing contact, while retiring the other 1,159 users.

**Tool `shadowrun_rehearse`** (completed)
```sql
UPDATE users SET deleted_at = now() WHERE last_login_at < now() - interval '1 year' AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = users.account_id AND a.status = 'active' AND users.role IN ('billing','owner') AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.account_id = users.account_id AND u2.id <> users.id AND u2.deleted_at IS NULL AND u2.last_login_at >= now() - in [cut]
```
Result: `blocked`
Blocked: A guardrail failed on the clone. Guardrails are frozen and cannot be approved past.
- measured: 1159 users updated directly (step 1)
- guardrails failed: Every active account keeps a live billing contact

> The role-based exclusion didn't work, so the guardrail must be tied to `invoices.billing_user_id` instead. I'm testing which invoice-referenced users it actually requires.

**Tool `shadowrun_query`** (completed)
```sql
SELECT count(*) AS active_accounts_where_no_invoice_has_live_billing_user FROM accounts a WHERE a.status='active' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.account_id = a.id AND i.billing_user_id IN (SELECT id FROM users WHERE deleted_at IS NULL AND last_login_at >= now() - interval '1 year'))
SELECT count(*) AS active_accounts_with_at_least_one_invoice_pointing_at_stale_billing_user FROM accounts a WHERE a.status='active' AND EXISTS (SELECT 1 FROM invoices i WHERE i.account_id = a.id AND i.billing_user_id IN (SELECT id FROM users WHERE deleted_at IS NULL AND last_login_at < now() - interval '1 year'))
SELECT count(DISTINCT i.billing_user_id) AS distinct_stale_billing_users_on_active_accounts FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE a.status='active' AND i.billing_user_id IN (SELECT id FROM users WHERE deleted_at IS NULL AND last_login_at < now() - interval '1 year')
SELECT count(DISTINCT u.id) AS distinct_stale_billing_users_total_all_accounts FROM invoices i JOIN users u ON u.id = i.billing_user_id WHERE u.deleted_at IS NULL AND u.last_login_at < now() - interval '1 year'
```

> I found 79 active accounts with missing live billing contacts and identified 73 stale users who are the only billing contacts referenced in active invoices. I'll exclude these users along with the last live billing/owner per account, then verify the exclusion set size.

**Tool `shadowrun_query`** (completed)
```sql
SELECT count(*) AS excluded_total, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE a.status='active' AND i.billing_user_id = u.id)) AS excluded_via_invoices, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE a.status='active' AND i.billing_user_id = u.id)) AS excluded_via_role_only FROM user [cut]
SELECT count(*) AS active_accounts_still_losing_billing_contact_after_exclusion FROM accounts a WHERE a.status='active' AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.account_id = a.id AND i.billing_user_id IN (SELECT id FROM users WHERE deleted_at IS NULL AND last_login_at >= now() - interval '1 year' UNION SELECT id FROM users u WHERE u.deleted_at IS NULL AND u.last_login_at < now() - interval [cut]
SELECT count(*) AS active_accounts_losing_last_billing_role_user_after_exclusion FROM accounts a WHERE a.status='active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id AND u.role IN ('billing','owner') AND (u.deleted_at IS NOT NULL OR u.last_login_at >= now() - interval '1 year' OR (u.last_login_at < now() - interval '1 year' AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.account [cut]
```

> I've verified that the exclusion set contains 77 users and no active accounts lose their last live billing/owner role. Now I'll check that no active account with invoices loses all live billing users and then rehearse the final plan.

**Tool `shadowrun_query`** (completed)
```sql
SELECT count(*) AS active_accounts_with_invoices_but_no_live_billing_user_after FROM accounts a WHERE a.status='active' AND EXISTS (SELECT 1 FROM invoices i WHERE i.account_id = a.id) AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.account_id = a.id AND i.billing_user_id IN (SELECT u.id FROM users u WHERE u.deleted_at IS NULL AND (u.last_login_at >= now() - interval '1 year' OR EXISTS (SELECT 1 F [cut]
```

**Tool `shadowrun_rehearse`** (completed)
```sql
UPDATE users SET deleted_at = now() WHERE last_login_at < now() - interval '1 year' AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM invoices i JOIN accounts a ON a.id = i.account_id WHERE a.status = 'active' AND i.billing_user_id = users.id) AND NOT (users.role IN ('billing','owner') AND EXISTS (SELECT 1 FROM accounts a2 WHERE a2.id = users.account_id AND a2.status = 'active') AND NOT EXISTS [cut]
```
Result: `awaiting_approval`
- measured: 1092 users updated directly (step 1)

> All 10 guardrails pass with a clean blast radius of 1,092 soft-deleted users. I'm submitting for apply now, but it exceeds the auto-apply budget so a person needs to approve it in the web app.

**Tool `shadowrun_apply`** (completed)
Result: `awaiting_approval`
- measured: 1092 users updated directly (step 1)
- Still waiting for a person. Call apply again after they approve.

> The migration is rehearsed and queued, but it needs a human approval before it runs on prod.
> 
> **What happened:**
> - A hard `DELETE` was blocked by your team's frozen guardrails — it would have cascaded into deleting 2,804 invoices, 2,064 orders, 5,175 order items, orphaned 2,704 payments, and left 62 accounts with zero users. The rules also forbid hard-deleting users entirely.
> - Final plan: soft-retire via `deleted_at = now()` — **1,092 users** (no logins in over a year), zero deletes, zero cascades. All 10 guardrails pass.
> - 77 stale users are deliberately kept live because retiring them would break a frozen rule: every active account must keep a live billing contact (73 are referenced as `billing_user_id` on active accounts' invoices; 4 are the last live billing/owner of their account).
> 
> **Action needed:** approve at https://144-202-92-64.sslip.io/runs/rfd4febe7871a41 (it exceeds the 10 [cut]
