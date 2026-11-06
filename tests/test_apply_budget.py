"""The real apply path against a real local Postgres: commit, rollback, drift, guardrail on prod."""
import subprocess
from pathlib import Path
from urllib.parse import urlparse

import psycopg
import pytest

from control.apply import apply_plan
from control.budget import check_budget
from control.snapshot import ProdConn, fingerprint, take_snapshot
from runner.guest import txrun

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.prod


@pytest.fixture()
def db(prod_dsn):
    u = urlparse(prod_dsn)
    name = "t_apply"
    admin = dict(host=u.hostname, port=u.port, user=u.username, password=u.password, dbname="postgres", sslmode="disable")
    with psycopg.connect(**admin, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        c.execute(f"CREATE DATABASE {name}")
    kw = {**admin, "dbname": name}
    with psycopg.connect(**kw) as c:
        c.execute("""
            CREATE TABLE parents (id int PRIMARY KEY, paid boolean NOT NULL);
            CREATE TABLE children (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES parents (id) ON DELETE CASCADE);
            INSERT INTO parents SELECT g, g % 2 = 0 FROM generate_series(1, 10) g;
            INSERT INTO children SELECT g, (g % 10) + 1 FROM generate_series(1, 30) g;
        """)
        c.commit()
    conn = ProdConn(u.hostname, str(u.port), u.username, u.password, name, "disable")
    yield kw, conn
    with psycopg.connect(**admin, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


def rehearse_on_copy(kw, steps, guardrails):
    """Same txrun code as the sandbox, against a rolled-back transaction, to get expected counts."""
    with psycopg.connect(**kw) as c:
        cur = c.cursor()
        txrun.snapshot_before(cur, txrun.before_tables(guardrails))
        results, err = txrun.run_statements(c, cur, steps)
        assert err is None
        counts = txrun.xact_counts(cur)
        schema = txrun.sha256_json(txrun.schema_state(cur))
        c.rollback()
    return {"xact_counts": counts, "schema_fingerprint_after": schema, "touched_tables": sorted(counts)}


def snapshot_tables(conn):
    return fingerprint(conn)["tables"]


STEPS = [{"statements": ["DELETE FROM parents WHERE id = 1"]}]


def rows(kw, sql):
    with psycopg.connect(**kw) as c:
        return c.execute(sql).fetchone()[0]


def test_clean_apply_commits_with_matching_counts(db):
    kw, conn = db
    rehearsal = rehearse_on_copy(kw, STEPS, [])
    out = apply_plan(conn, STEPS, [], rehearsal, snapshot_tables(conn))
    assert out["outcome"] == "committed"
    assert out["actual_counts"] == rehearsal["xact_counts"]
    assert out["actual_counts"]["children"]["del"] == 3, "cascades must be counted"
    assert rows(kw, "SELECT count(*) FROM parents") == 9


def test_drift_is_detected_and_nothing_applied(db):
    kw, conn = db
    rehearsal = rehearse_on_copy(kw, STEPS, [])
    tables = snapshot_tables(conn)
    with psycopg.connect(**kw) as c:
        c.execute("INSERT INTO children VALUES (1000, 1)")
        c.commit()
    out = apply_plan(conn, STEPS, [], rehearsal, tables)
    assert out["outcome"] == "drift_detected"
    assert rows(kw, "SELECT count(*) FROM parents") == 10


def test_with_drift_check_off_a_count_mismatch_rolls_back(db):
    """Done-when for block 5."""
    kw, conn = db
    rehearsal = rehearse_on_copy(kw, STEPS, [])
    tables = snapshot_tables(conn)
    with psycopg.connect(**kw) as c:
        c.execute("INSERT INTO children VALUES (1000, 1)")
        c.commit()
    out = apply_plan(conn, STEPS, [], rehearsal, tables, check_drift=False)
    assert out["outcome"] == "rolled_back"
    assert out["count_mismatches"][0]["table"] == "children"
    assert rows(kw, "SELECT count(*) FROM parents") == 10, "the rollback must leave prod untouched"


def test_guardrail_failure_on_prod_rolls_back(db):
    kw, conn = db
    guard = [{"id": "g", "name": "no parent lost", "sql": "SELECT b.id FROM before.parents b LEFT JOIN parents p USING (id) WHERE p.id IS NULL"}]
    rehearsal = rehearse_on_copy(kw, STEPS, guard)
    out = apply_plan(conn, STEPS, guard, rehearsal, snapshot_tables(conn))
    assert out["outcome"] == "rolled_back" and "guardrail" in out["reason"]
    assert rows(kw, "SELECT count(*) FROM parents") == 10


def test_statement_failure_rolls_back_earlier_steps(db):
    kw, conn = db
    steps = [{"statements": ["DELETE FROM children WHERE id = 1"]}, {"statements": ["SELECT * FROM missing_table"]}]
    out = apply_plan(conn, steps, [], {"xact_counts": {}, "touched_tables": []}, {})
    assert out["outcome"] == "rolled_back"
    assert rows(kw, "SELECT count(*) FROM children") == 30


def test_snapshot_id_is_stable_for_unchanged_data(db):
    kw, conn = db
    assert fingerprint(conn)["digest"] == fingerprint(conn)["digest"]
    before = fingerprint(conn)["digest"]
    with psycopg.connect(**kw) as c:
        c.execute("UPDATE parents SET paid = NOT paid WHERE id = 1")
        c.commit()
    assert fingerprint(conn)["digest"] != before


def test_a_failing_guardrail_is_not_within_budget():
    report = {"totals": {"rows_changed": 1}, "tables": [], "schema_diff": []}
    assert check_budget(report, {"verdict": "pass"}, [{"passed": False}])["within"] is False


@pytest.mark.parametrize("totals,gate,within", [
    ({"rows_changed": 10}, "pass", True), ({"rows_changed": 101}, "pass", False), ({"rows_changed": 10, "rows_via_cascade": 1}, "pass", False),
    ({"rows_changed": 10, "tables_dropped": 1}, "pass", False), ({"rows_changed": 10, "tables_truncated": 1}, "pass", False), ({"rows_changed": 1}, "review", False), ({}, "pass", False),
])
def test_budget(totals, gate, within):
    assert check_budget({"totals": totals, "tables": [], "schema_diff": []}, {"verdict": gate}, [])["within"] is within


def test_take_snapshot_makes_a_restorable_dump(db, tmp_path, monkeypatch):
    _, conn = db
    monkeypatch.setenv("PATH", f"{ROOT}/scripts/dev/bin:{subprocess.os.environ['PATH']}")
    snap = take_snapshot(conn, tmp_path)
    assert Path(snap["dump_path"]).stat().st_size > 0
    assert snap["snapshot_id"].startswith("s") and snap["tables"]["parents"]["rows"] == 10


def test_a_capture_gap_is_never_within_budget():
    report = {"totals": {"rows_changed": 1}, "tables": [], "schema_diff": [], "capture_gaps": [{"table": "t", "op": "DELETE", "postgres_counted": 5, "log_has": 0}]}
    assert check_budget(report, {"verdict": "pass"}, [])["within"] is False


def test_a_small_delete_still_needs_a_person():
    """Under every numeric limit, and irreversible all the same."""
    report = {"totals": {"rows_changed": 1}, "tables": [], "schema_diff": []}
    assert check_budget(report, {"verdict": "pass", "highest_risk": "irreversible_write"}, [])["within"] is False
    assert check_budget(report, {"verdict": "pass", "highest_risk": "reversible_write"}, [])["within"] is True


def test_a_measured_delete_needs_a_person_whatever_the_gate_thought():
    report = {"totals": {"rows_changed": 50, "rows_deleted": 50}, "tables": [], "schema_diff": []}
    assert check_budget(report, {"verdict": "pass", "highest_risk": "reversible_write"}, [])["within"] is False


def test_a_measured_file_delete_needs_a_person_whatever_the_gate_thought():
    report = {"kind": "host", "totals": {"files_deleted": 1}}
    assert check_budget(report, {"verdict": "pass", "highest_risk": "read"}, [])["within"] is False


def test_new_code_on_prod_needs_a_person():
    report = {"totals": {"rows_changed": 1}, "tables": [], "schema_diff": [{"kind": "trigger", "name": "t.x", "change": "added"}]}
    assert check_budget(report, {"verdict": "pass"}, [])["within"] is False


def test_an_unlogged_rewrite_needs_a_person():
    report = {"totals": {"ddl_commands": 1}, "tables": [], "schema_diff": [], "unlogged_changes": [{"table": "users", "detail": "x"}]}
    assert check_budget(report, {"verdict": "pass"}, [])["within"] is False


def rehearse_with_content(kw, steps, guardrails):
    """The real order of operations: run, then measure, on a copy that is rolled back."""
    with psycopg.connect(**kw) as c:
        cur = c.cursor()
        base = txrun.snapshot_before(cur, txrun.before_tables(guardrails))
        _, err = txrun.run_statements(c, cur, steps)
        assert err is None and txrun.verify_before(cur, base) is None
        counts = txrun.xact_counts(cur)
        schema = txrun.sha256_json(txrun.schema_state(cur))
        cols = txrun.table_columns(cur)
        content = txrun.content_hashes(cur, {t: cols.get(t, []) for t in counts})
        c.rollback()
    return {"xact_counts": counts, "schema_fingerprint_after": schema, "touched_tables": sorted(counts), "content_after": content}


def test_same_counts_different_content_rolls_back(db):
    """A plan that behaves differently on prod, keeping the row count identical."""
    kw, conn = db
    with psycopg.connect(**kw) as c:
        c.execute("ALTER TABLE parents ADD COLUMN note text")
        c.commit()
    rehearsal = rehearse_with_content(kw, [{"statements": ["UPDATE parents SET note = 'clean' WHERE id <= 3"]}], [])
    out = apply_plan(conn, [{"statements": ["UPDATE parents SET note = 'pwned' WHERE id <= 3"]}], [], rehearsal, snapshot_tables(conn))
    assert out["outcome"] == "rolled_back" and out["content_mismatches"][0]["table"] == "parents"
    assert out["actual_counts"] == rehearsal["xact_counts"], "the counts alone would have let this through"
    assert rows(kw, "SELECT count(*) FROM parents WHERE note = 'pwned'") == 0


def test_a_timestamp_set_from_now_still_matches(db):
    """The check that makes the content comparison usable: now() differs between rehearsal and apply."""
    kw, conn = db
    with psycopg.connect(**kw) as c:
        c.execute("ALTER TABLE parents ADD COLUMN deleted_at timestamptz")
        c.commit()
    steps = [{"statements": ["UPDATE parents SET deleted_at = now() WHERE id <= 3"]}]
    rehearsal = rehearse_with_content(kw, steps, [])
    out = apply_plan(conn, steps, [], rehearsal, snapshot_tables(conn))
    assert out["outcome"] == "committed", out.get("reason")


def test_setting_a_timestamp_on_different_rows_does_not_match(db):
    kw, conn = db
    with psycopg.connect(**kw) as c:
        c.execute("ALTER TABLE parents ADD COLUMN deleted_at timestamptz")
        c.commit()
    rehearsal = rehearse_with_content(kw, [{"statements": ["UPDATE parents SET deleted_at = now() WHERE id <= 3"]}], [])
    out = apply_plan(conn, [{"statements": ["UPDATE parents SET deleted_at = now() WHERE id BETWEEN 4 AND 6"]}], [], rehearsal, snapshot_tables(conn))
    assert out["outcome"] == "rolled_back"


def test_a_plan_that_rewrites_the_guardrail_baseline_rolls_back(db):
    kw, conn = db
    guard = [{"id": "g", "name": "no parent lost", "sql": "SELECT b.id FROM before.parents b LEFT JOIN parents p USING (id) WHERE p.id IS NULL"}]
    steps = [{"statements": ["DELETE FROM parents WHERE id = 1", "DELETE FROM pg_temp.before_parents WHERE id = 1"]}]
    out = apply_plan(conn, steps, guard, {"xact_counts": {}, "touched_tables": []}, {})
    assert out["outcome"] == "rolled_back" and "baseline" in out["reason"]
    assert rows(kw, "SELECT count(*) FROM parents") == 10


def test_a_deferred_trigger_fires_inside_the_measured_window(db):
    kw, conn = db
    with psycopg.connect(**kw) as c:
        c.execute("""
            CREATE FUNCTION bomb() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN DELETE FROM children; RETURN NULL; END $x$;
            CREATE CONSTRAINT TRIGGER bomb AFTER UPDATE ON parents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bomb();
        """)
        c.commit()
    with psycopg.connect(**kw) as c:
        cur = c.cursor()
        _, err = txrun.run_statements(c, cur, [{"statements": ["UPDATE parents SET paid = NOT paid WHERE id = 1"]}])
        assert err is None
        counts = txrun.xact_counts(cur)
        c.rollback()
    assert counts["children"]["del"] == 30, "the deferred trigger's damage must be counted before COMMIT"


def test_new_triggers_and_functions_appear_in_the_schema_state(db):
    kw, _ = db
    with psycopg.connect(**kw) as c:
        cur = c.cursor()
        before = txrun.schema_state(cur)
        cur.execute("CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END $x$")
        cur.execute("CREATE TRIGGER x AFTER INSERT ON parents FOR EACH ROW EXECUTE FUNCTION f()")
        after = txrun.schema_state(cur)
        c.rollback()
    added = {tuple(r[:2]) for r in after} - {tuple(r[:2]) for r in before}
    assert ("trigger", "parents.x") in added and any(k == "function" for k, _ in added)
