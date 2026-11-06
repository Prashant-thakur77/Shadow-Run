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


SCOPE = {"auto_apply_scope": {"job_logs": "*", "products": ["name"]}}


def _table(name, **kw):
    return {"table": name, "inserted": 0, "updated": 0, "deleted": 0, "dropped": False, "truncated": False, "rows_before": 10, **kw}


def _report(tables, columns=None, schema=()):
    return {"totals": {"rows_changed": 1}, "tables": tables, "schema_diff": list(schema), "changed_columns": columns}


@pytest.mark.parametrize("report,within", [
    (_report([_table("products", updated=1)], {"products": {"name": 1}}), True),
    (_report([_table("products", updated=1)], {"products": {"name": 1, "price_cents": 1}}), False),
    (_report([_table("products", inserted=1)], {}), False),
    (_report([_table("products", updated=1)], None), False),  # columns not measured counts against the plan
    (_report([_table("job_logs", inserted=5)], {}), True),
    (_report([_table("invoices", updated=1)], {"invoices": {"amount_cents": 1}}), False),
    (_report([], {}, [{"kind": "column", "name": "invoices.note", "change": "added"}]), False),
    (_report([], {}, [{"kind": "column", "name": "job_logs.note", "change": "added"}]), True),
    (_report([], {}, [{"kind": "column", "name": "products.note", "change": "added"}]), False),
])
def test_only_named_tables_and_columns_can_change_alone(report, within):
    assert check_budget(report, {"verdict": "pass"}, [], SCOPE)["within"] is within


def test_the_default_scope_is_nothing():
    assert check_budget(_report([_table("products", updated=1)], {"products": {"name": 1}}), {"verdict": "pass"}, [])["within"] is False


def test_a_row_budget_alone_is_the_baseline_the_gauntlet_measures():
    report = _report([_table("invoices", updated=1)], {"invoices": {"amount_cents": 1}})
    assert check_budget(report, {"verdict": "pass"}, [], {"auto_apply_scope": None})["within"] is True


def test_a_moved_business_number_needs_a_person():
    report = {**_report([_table("products", updated=1)], {"products": {"name": 1}}), "metrics": [{"name": "Paid revenue", "before": 2, "after": 1}]}
    assert check_budget(report, {"verdict": "pass"}, [], SCOPE)["within"] is False


def _host(files, **kw):
    counts = {k: len(files.get(k, [])) for k in ("created", "changed", "deleted")}
    return {"kind": "host", "totals": {"files_changed": counts["changed"]}, "files": {**files, "counts": counts}, **kw}


@pytest.mark.parametrize("report,within", [
    (_host({"changed": ["/var/app/logs/a"]}), True),
    (_host({"changed": ["/etc/nginx/nginx.conf"]}), False),
    (_host({"created": ["/usr/local/bin/x"]}), False),
    (_host({"changed": ["/var/app/logs/a"]}, services_started=["backdoor"]), False),
])
def test_host_changes_stay_inside_the_named_paths(report, within):
    budget = {"auto_apply_paths": ["/var/app/logs/"]}
    assert check_budget(report, {"verdict": "pass"}, [], budget)["within"] is within


def test_a_capped_file_list_cant_clear_a_longer_change():
    report = _host({"changed": ["/var/app/logs/a"]})
    report["files"]["counts"]["changed"] = 400
    report["totals"]["files_changed"] = 2
    assert check_budget(report, {"verdict": "pass"}, [], {"auto_apply_paths": ["/var/app/logs/"]})["within"] is False


class TestReleaseWithinBudget:
    """What an agent's apply call may do with a run it rehearsed through MCP."""

    @pytest.fixture
    def svc(self, tmp_path, monkeypatch):
        from control import approvals, settings
        from control.service import Service
        from control.store import Store

        monkeypatch.setattr(settings, "HMAC_SECRET", "test-secret")
        s = Service.__new__(Service)
        s.store = Store(tmp_path / "s.sqlite3")
        s.store.save_target({"id": "t", "kind": "postgres", "guardrails": [], "auto_apply_within_budget": True})
        self.approvals = approvals
        return s

    def _run(self, svc, within=True, source="mcp", rehearse_only=True, status="awaiting_approval"):
        run = {
            "id": "r1", "status": status, "requester": "agent", "target_id": "t", "source": source, "rehearse_only": rehearse_only, "created_at": 0, "events": [],
            "plan_hash": "p" * 64, "guardrails_hash": "g" * 64, "report_hash": "h" * 64, "final_attempt": 1,
            "attempts": [{"n": 1, "budget": {"within": within, "limits": {}}}],
        }
        self.approvals.open_challenge(run)
        svc.store.save_run(run)
        return run

    def test_a_change_on_the_list_goes_ahead_when_the_agent_asks(self, svc):
        self._run(svc)
        released = svc.release_within_budget("r1")
        assert released["status"] == "approved" and released["approval"]["kind"] == "auto_budget"
        self.approvals.verify(released, released["approval"])

    @pytest.mark.parametrize("kw", [{"within": False}, {"source": "cli"}, {"rehearse_only": False}, {"status": "blocked"}])
    def test_anything_else_stays_with_a_person(self, svc, kw):
        self._run(svc, **kw)
        assert svc.release_within_budget("r1") is None
        assert svc.store.get_run("r1")["status"] == kw.get("status", "awaiting_approval")


def test_one_visitor_cant_use_up_everyones_limit():
    """Every guest is the same identity on the demo, so limits go by address."""
    from fastapi import HTTPException

    from control import api

    api._hits.clear()
    api.client_ip.set("1.1.1.1")
    api.limit("judge", "gauntlet runs", 2)
    api.limit("judge", "gauntlet runs", 2)
    with pytest.raises(HTTPException) as e:
        api.limit("judge", "gauntlet runs", 2)
    assert e.value.status_code == 429
    api.client_ip.set("2.2.2.2")
    api.limit("judge", "gauntlet runs", 2)


class TestConfiguredTargets:
    GOOD = "- id: mine\n  connection: {host: h, port: 5432, user: u, password_env: P, dbname: d}\n  guardrails:\n    - {id: g, name: G, sql: 'SELECT 1 WHERE false'}\n"

    def _load(self, tmp_path, text):
        from control.service import configured_targets

        path = tmp_path / "targets.yaml"
        path.write_text(text)
        return configured_targets(path)

    def test_a_new_target_waits_for_a_person_on_everything(self, tmp_path):
        t = self._load(tmp_path, self.GOOD)[0]
        assert t["auto_apply_within_budget"] is False and t["budget"]["auto_apply_scope"] == {} and t["demo_controls"] is False

    def test_a_listed_scope_turns_auto_apply_on(self, tmp_path):
        t = self._load(tmp_path, self.GOOD + "  budget: {auto_apply_scope: {flags: [note]}}\n")[0]
        assert t["auto_apply_within_budget"] is True and t["budget"]["auto_apply_scope"] == {"flags": ["note"]}

    def test_a_guardrail_that_writes_stops_the_file_from_loading(self, tmp_path):
        with pytest.raises(ValueError, match="only read|one statement"):
            self._load(tmp_path, self.GOOD.replace("SELECT 1 WHERE false", "WITH d AS (DELETE FROM t RETURNING 1) SELECT 1"))

    def test_a_password_in_the_file_is_refused(self, tmp_path):
        with pytest.raises(ValueError, match="password_env"):
            self._load(tmp_path, self.GOOD.replace("password_env: P", "password: hunter2"))

    def test_the_example_file_loads(self):
        from pathlib import Path

        from control.service import configured_targets

        assert configured_targets(Path("examples/targets.yaml"))[0]["id"] == "my-app"


@pytest.mark.parametrize("name", ["demo_reset", "make_drift"])
async def test_demo_writes_refuse_anything_but_a_demo_target(monkeypatch, name):
    """These write straight to the target's database. On a team's own database, reset would destroy it."""
    from fastapi import HTTPException

    from control import api

    class Svc:
        class store:
            @staticmethod
            def get_target(_):
                return {"id": "mine", "kind": "postgres", "demo_controls": False, "connection": {"host": "real"}}

    monkeypatch.setattr(api, "svc", lambda: Svc)
    with pytest.raises(HTTPException) as e:
        await getattr(api, name)("mine", user="judge")
    assert e.value.status_code == 403
