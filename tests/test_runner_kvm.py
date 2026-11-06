"""Block 2 and 3 checks against real microVMs. Skipped where /dev/kvm is unavailable."""
import asyncio
import time
import uuid

import pytest
import pytest_asyncio
from conftest import msb_ok, msb_sandboxes

from checker.blast import build_report
from runner.engine import Engine, teardown_proof

pytestmark = [pytest.mark.kvm, pytest.mark.skipif(not msb_ok(), reason="needs msb and /dev/kvm")]

TRAP = "DELETE FROM users WHERE last_login_at < now() - interval '1 year'"
GUARD = {
    "id": "paid_invoices",
    "name": "no paid invoice lost",
    "sql": "SELECT b.id FROM before.invoices b LEFT JOIN invoices i USING (id) WHERE b.status='paid' AND i.id IS NULL",
}


def rid() -> str:
    return uuid.uuid4().hex[:12]


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def golden(demo_dump):
    eng = Engine()
    sid = f"t{rid()}"
    info = await eng.ensure_golden(sid, demo_dump)
    assert not info["cached"]
    yield eng, sid
    await eng.drop_golden(sid)


pytestmark.append(pytest.mark.asyncio(loop_scope="module"))


async def test_plan_runs_returns_counts_and_leaves_nothing(golden):
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": [TRAP]}], [GUARD])
    assert rec.get("sandbox_error") is None
    assert rec["result"]["ok"] is True
    assert rec["result"]["xact_counts"]["users"]["del"] > 0
    assert rec["teardown"]["ok"] is True
    assert rec["contained"] is True
    assert rec["sandbox"] not in msb_sandboxes()


async def test_guest_has_no_network_device_and_differs_from_host(golden):
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["SELECT 1"]}], [])
    assert set(rec["probes"]["nics"]) <= {"lo", "dummy0"}
    assert rec["probes"]["routes"] == 0
    assert all(t["result"] == "BLOCKED" for t in rec["probes"]["targets"])
    assert rec["probes"]["dns"].startswith("BLOCKED")
    assert rec["guest"]["kernel"] != rec["host"]["kernel"]


async def test_failed_plan_still_destroys(golden):
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["SELECT * FROM no_such_table"]}], [])
    assert rec["result"]["ok"] is False
    assert "no_such_table" in rec["result"]["error"]
    assert rec["teardown"]["ok"] is True
    assert rec["sandbox"] not in msb_sandboxes()


async def test_timeout_still_destroys(golden):
    eng, sid = golden
    t0 = time.perf_counter()
    rec = await eng.rehearse(rid(), sid, [{"statements": ["SELECT pg_sleep(600)"]}], [], max_duration=6)
    assert time.perf_counter() - t0 < 40
    assert rec.get("sandbox_error"), "a hung plan must not look like a pass"
    assert rec["teardown"]["ok"] is True
    assert rec["sandbox"] not in msb_sandboxes()


async def test_clone_is_never_reused(golden):
    eng, sid = golden
    first = await eng.rehearse(rid(), sid, [{"statements": ["DROP TABLE orders CASCADE", "TRUNCATE invoices CASCADE"]}], [])
    assert first["result"]["ok"] is True
    second = await eng.rehearse(rid(), sid, [{"statements": ["SELECT 1"]}], [])
    assert second["result"]["table_rows_before"]["orders"] > 0
    assert second["result"]["table_rows_before"]["invoices"] > 0


async def test_plan_cannot_escape_its_transaction(golden):
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["COMMIT", "DROP TABLE orders CASCADE"]}], [])
    assert rec["result"]["ok"] is False
    assert "ended the enclosing transaction" in rec["result"]["error"]


async def test_plan_cannot_read_or_edit_its_own_record(golden):
    eng, sid = golden
    for stmt in ["DELETE FROM shadow.changes", "UPDATE shadow.ctl SET step = 99", "DROP EVENT TRIGGER shadow_ddl_end"]:
        rec = await eng.rehearse(rid(), sid, [{"statements": [stmt]}], [])
        assert rec["result"]["ok"] is False, stmt
        assert "permission denied" in rec["result"]["error"] or "must be" in rec["result"]["error"], rec["result"]["error"]


async def test_new_tables_are_captured(golden):
    eng, sid = golden
    rec = await eng.rehearse(
        rid(), sid, [{"statements": ["CREATE TABLE scratch (id int)", "INSERT INTO scratch SELECT generate_series(1, 7)"]}], []
    )
    assert rec["result"]["ok"] is True
    rows = {(c["table"], c["op"]): c["rows"] for c in rec["result"]["changes"]}
    assert rows[("scratch", "INSERT")] == 7
    assert [d["tag"] for d in rec["result"]["ddl"]] == ["CREATE TABLE"], "capture's own triggers must not count as the plan's DDL"


async def test_secret_scan_finds_nothing_and_host_env_does_not_leak(golden, monkeypatch):
    eng, sid = golden
    monkeypatch.setenv("SHADOWRUN_CANARY", "SRCANARY-deadbeefdeadbeef")
    rec = await eng.rehearse(rid(), sid, [{"statements": ["SELECT 1"]}], [])
    assert rec["secret_scan"]["ok"] is True, rec["secret_scan"]
    assert rec["secret_scan"]["scanned"] > 50


async def test_report_says_invoices_deleted_via_cascade_from_users(golden):
    """Block 3 done-when."""
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": [TRAP]}], [GUARD])
    report = build_report(rec["result"])
    texts = [s["text"] for s in report["sentences"]]
    line = next(t for t in texts if " invoices deleted via cascade from users (step 1)" in t)
    n = int(line.split()[0])
    assert n == rec["result"]["xact_counts"]["invoices"]["del"] > 0
    assert rec["result"]["guardrails"][0]["passed"] is False
    assert report["totals"]["rows_via_cascade"] > 0
    assert any(e["from"] == "users" and e["to"] == "invoices" for e in report["cascade_graph"]["edges"])
    print("\n".join(texts))


async def test_dropped_table_is_reported_with_its_row_count(golden):
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["DROP TABLE orders CASCADE"]}], [])
    report = build_report(rec["result"])
    t = next(x for x in report["tables"] if x["table"] == "orders")
    assert t["dropped"] is True and t["deleted"] == rec["result"]["table_rows_before"]["orders"]


async def test_cold_start_is_recorded(golden):
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["SELECT 1"]}], [])
    assert 0 < rec["phases"]["clone_boot_ms"] < 15000
    assert rec["phases"]["total_ms"] >= rec["phases"]["clone_boot_ms"]


async def test_teardown_proof_detects_a_live_sandbox():
    """The proof itself has to be able to fail, or it proves nothing."""
    from microsandbox import Network, Sandbox

    name = f"sr-run-proof{rid()}"
    sb = await Sandbox.create(name, image="sr-target:0.1", cpus=1, memory=256, network=Network.none(), max_duration=30)
    try:
        proof = await teardown_proof(name)
        assert proof["ok"] is False and proof["sandbox_listed"] is True
    finally:
        await sb.destroy(force=True)
    assert (await teardown_proof(name))["ok"] is True


async def test_janitor_removes_old_sandboxes(golden):
    from microsandbox import Network, Sandbox

    eng, _ = golden
    name = f"sr-run-old{rid()}"
    sb = await Sandbox.create(name, image="sr-target:0.1", cpus=1, memory=256, network=Network.none(), max_duration=60)
    await sb.detach()
    await asyncio.sleep(1.2)
    killed = await eng.janitor_once(max_age_s=1)
    assert name in killed
    assert name not in msb_sandboxes()


async def test_host_target_measures_files_services_and_cleans_up():
    """Block 11: shell plan on a host clone. Files and services measured, real prod host untouched."""
    from checker.blast import build_host_report

    eng = Engine()
    hid = f"t{rid()}"
    guard = [
        {"id": "keys", "name": "signing keys present", "sh": "/var/app/bin/nightly-sign.sh"},
        {"id": "web", "name": "nginx serving", "sh": "curl -sf -m 3 http://localhost/ | grep -q 'release current'"},
    ]
    await eng.ensure_prodhost(hid)
    try:
        before = await eng.prodhost_fingerprint(hid)
        rec = await eng.rehearse_host(rid(), hid, [{"cmd": "rm -rf /var/app/cache/*"}, {"cmd": "systemctl stop nginx"}], guard)
        assert rec.get("sandbox_error") is None, rec.get("sandbox_error")
        assert rec["contained"] is True, rec
        result = rec["result"]
        assert "nginx.service" in result["services_stopped"]
        assert "80" in result["ports_closed"]
        assert result["files"]["counts"]["deleted"] > 200
        assert {g["id"]: g["passed"] for g in result["guardrails"]} == {"keys": False, "web": False}
        report = build_host_report(result)
        assert any("nginx.service stopped" in s["text"] for s in report["sentences"])
        after = await eng.prodhost_fingerprint(hid)
        assert before["digest"] == after["digest"], "the real host must be untouched by the rehearsal"
        assert rec["sandbox"] not in msb_sandboxes()

        # Apply with a failing guardrail: the host must be restored to its exact prior state.
        applied = await eng.prodhost_apply(hid, [{"cmd": "rm -rf /var/app/cache/*"}], guard)
        assert applied["result"]["guardrails"][0]["passed"] is False
        await eng.prodhost_rollback(hid, applied["services_before"]["running"])
        restored = await eng.prodhost_fingerprint(hid)
        assert restored["digest"] == before["digest"], "rollback must restore files and services exactly"
    finally:
        await eng.remove_prodhost(hid)


async def test_crafted_table_name_cannot_inject_into_the_measurement(golden):
    """A plan picks its own table names, and the superuser session reads them back."""
    eng, sid = golden
    evil = 'x"; DROP TABLE accounts CASCADE; --'
    quoted = '"' + evil.replace('"', '""') + '"'
    rec = await eng.rehearse(rid(), sid, [{"statements": [f"CREATE TABLE {quoted} (id int)", f"INSERT INTO {quoted} VALUES (1)"]}], [])
    assert rec.get("sandbox_error") is None, rec.get("sandbox_error")
    assert rec["result"]["ok"] is True, rec["result"].get("error")
    assert evil in rec["result"]["table_rows_after"]
    assert "accounts" in rec["result"]["table_rows_after"], "the crafted name must not have run as SQL"


async def test_disabling_the_capture_trigger_is_caught_by_postgres_statistics(golden):
    """The gate blocks this. This test goes around the gate, to prove the second check holds on its own."""
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["ALTER TABLE sessions DISABLE TRIGGER USER", "DELETE FROM sessions WHERE id < 100"]}], [])
    result = rec["result"]
    assert result["ok"] is True, result.get("error")
    assert result["xact_counts"]["sessions"]["del"] > 0
    assert any(g["table"] == "sessions" and g["op"] == "DELETE" for g in result["capture_gaps"]), result["capture_gaps"]


async def test_guardrail_cannot_be_fooled_by_a_shadowed_function(golden):
    eng, sid = golden
    guard = [{"id": "rev", "name": "revenue unchanged", "sql": "SELECT 1 FROM (SELECT (SELECT sum(amount_cents) FROM before.invoices) AS was, (SELECT sum(amount_cents) FROM invoices) AS now) x WHERE was <> now"}]
    plan = [
        "CREATE FUNCTION public.sum(int) RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint'",
        "DELETE FROM invoices WHERE id < 50",
    ]
    rec = await eng.rehearse(rid(), sid, [{"statements": plan}], guard)
    gs = rec["result"]["guardrails"]
    assert gs and gs[0]["passed"] is False, f"the guardrail must still see the real sum: {gs}"


async def test_read_only_plan_changes_nothing(golden):
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["SELECT count(*) FROM users"]}], [])
    assert rec["result"]["changes"] == [] and rec["result"]["capture_gaps"] == []


async def test_a_table_rewrite_is_not_invisible(golden):
    """ALTER COLUMN TYPE USING fires no row trigger and moves no statistic."""
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["ALTER TABLE users ALTER COLUMN email TYPE text USING 'wiped' || id"]}], [])
    result = rec["result"]
    assert result["ok"] is True, result.get("error")
    assert result["xact_counts"] == {} and result["capture_gaps"] == [], "the existing measurements really are blind to this"
    assert any(u["table"] == "users" for u in result["unlogged_changes"]), result["unlogged_changes"]
    assert "users" in result["content_after"]


async def test_adding_a_column_is_not_flagged_as_a_rewrite(golden):
    eng, sid = golden
    rec = await eng.rehearse(rid(), sid, [{"statements": ["ALTER TABLE users ADD COLUMN nickname text DEFAULT 'x'"]}], [])
    assert rec["result"]["unlogged_changes"] == [], rec["result"]["unlogged_changes"]


async def test_a_deferred_trigger_is_measured_in_the_rehearsal(golden):
    eng, sid = golden
    plan = [
        "CREATE FUNCTION bomb() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN DELETE FROM audit_log; RETURN NULL; END $x$",
        "CREATE CONSTRAINT TRIGGER bomb AFTER UPDATE ON feature_flags DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bomb()",
        "UPDATE feature_flags SET note = 'x' WHERE key = 'sso'",
    ]
    rec = await eng.rehearse(rid(), sid, [{"statements": plan}], [])
    result = rec["result"]
    assert result["ok"] is True, result.get("error")
    assert result["xact_counts"]["audit_log"]["del"] > 0
    report = build_report(result)
    assert report["totals"]["rows_deleted"] > 0
    assert any(d["kind"] == "trigger" and d["change"] == "added" for d in report["schema_diff"])


async def test_rewriting_the_baseline_fails_the_rehearsal(golden):
    eng, sid = golden
    guard = [GUARD]
    plan = ["DELETE FROM invoices WHERE id = 79", "DELETE FROM pg_temp.before_invoices WHERE id = 79"]
    rec = await eng.rehearse(rid(), sid, [{"statements": plan}], guard)
    assert rec["result"]["ok"] is False and "baseline" in rec["result"]["error"]
