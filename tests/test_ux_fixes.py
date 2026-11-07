"""What a first-time visitor runs into: taking a race's plan to prod, the drift demo, expired approvals, refusals, the feed."""
import asyncio
import io
import json
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient

from control import agent, api, auth, cli, hero, service, settings
from control.plan import normalize_plan, plan_hash
from control.service import DEMO_TARGET_ID, Service
from control.store import Store
from runner.guest import txrun

ROOT = Path(__file__).resolve().parent.parent
NOTE_PLAN = "UPDATE feature_flags SET note = 'x' WHERE key = 'beta_search'"


def rehearsal(tables=None, touched=("feature_flags",)):
    return {
        "contained": True, "sandbox_error": None, "phases": {"total_ms": 1},
        "result": {
            "ok": True, "error": None, "changes": [{"step": 1, "table": "feature_flags", "op": "UPDATE", "via": "direct", "rows": 1}],
            "table_rows_before": {"feature_flags": 4}, "table_rows_after": {"feature_flags": 4}, "foreign_keys": [], "ddl": [], "schema_diff": [], "samples": {},
            "xact_counts": {"feature_flags": {"ins": 0, "upd": 1, "del": 0}}, "changed_columns": {"feature_flags": {"note": 1}},
            "guardrails": [{"id": "g", "name": "guard", "passed": True, "violations": [], "violation_count_capped": 0}],
            "schema_fingerprint_after": "s", "sequences_moved": [], "touched_tables": list(touched),
        },
    }


class FakeRunner:
    async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
        return rehearsal()


@pytest.fixture
def svc(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "HMAC_SECRET", "test-secret")
    s = Service.__new__(Service)
    s.store = Store(tmp_path / "s.sqlite3")
    s.runner = FakeRunner()
    s._tasks = set()
    s._apply_lock = asyncio.Lock()
    s.store.save_target({
        "id": DEMO_TARGET_ID, "kind": "postgres", "name": "demo", "demo_controls": True, "guardrails": [{"id": "g", "name": "guard", "sql": "SELECT 1 WHERE false"}],
        "budget": {"auto_apply_scope": {"feature_flags": ["note"]}, "allow_ddl": False}, "auto_apply_within_budget": True, "metrics": [],
    })

    async def ensure_snapshot(target):
        return {"snapshot_id": "s1", "digest": "d1", "cached": True, "timing": {}, "tables": {"feature_flags": {"rows": 4, "hash": "h"}}}

    async def inspection_for(target, snapshot_id):
        return {"tables": [], "foreign_keys": []}

    async def scan_suspect_rows(snapshot_id):
        return []

    async def prod_check(run, target, snap):
        run["prod_check"] = {"before": "d1", "after": "d1", "unchanged": True}

    s.ensure_snapshot, s.inspection_for, s.scan_suspect_rows, s._prod_check = ensure_snapshot, inspection_for, scan_suspect_rows, prod_check
    monkeypatch.setattr(agent, "call_planner", lambda *a, **k: {"steps": [{"type": "sql", "cmd": NOTE_PLAN, "why": "asked"}], "summary": "note"})
    monkeypatch.setattr(agent, "explain", lambda *a, **k: {"text": "x", "numbers_verified": True})
    monkeypatch.setattr(service, "second_opinion", lambda *a, **k: {"model": "m", "verdict": "does_it", "left_out": "", "added": ""})
    return s


@pytest.fixture
def client(svc, monkeypatch):
    api._hits.clear()
    hero._examples_cache.update(at=0.0, value=[])
    monkeypatch.setattr(api, "svc", lambda: svc)
    monkeypatch.setattr(api, "require_inference_budget", lambda: None)
    api.app.dependency_overrides[auth.current_user] = lambda: "judge"
    c = TestClient(api.app)
    # The route's own event loop ends with the request, so a test drives each run it started by itself.
    c.started = []
    yield c
    api.app.dependency_overrides.clear()


async def settle(svc):
    while svc._tasks:
        await asyncio.gather(*list(svc._tasks))


async def finished_race(svc):
    race = svc.start_race("Note this flag", "judge")
    await settle(svc)
    return race, svc.store.get_run(race["through"])


def hold_runs(svc, client):
    """Keeps the ids of runs a route starts, for drive() to run in this test's own loop."""
    svc.start = lambda run: client.started.append(run["id"])


async def drive(svc, client):
    for run_id in client.started:
        await svc._drive(run_id)
    client.started.clear()


# ------------------------------------------------------------------ take this plan to prod


def steps_of(run):
    return [{"type": s["type"], "cmd": s["cmd"], "why": s.get("why", "")} for s in next(a for a in run["attempts"] if a["n"] == run["final_attempt"])["plan"]["steps"]]


async def test_the_exact_plan_starts_a_normal_run_that_waits_for_a_person(svc, client):
    race, lane = await finished_race(svc)
    hold_runs(svc, client)
    res = client.post("/api/runs", json={"steps": steps_of(lane), "from_race": race["id"]})
    assert res.status_code == 201
    await drive(svc, client)
    run = svc.store.get_run(res.json()["id"])
    assert run["task"] == "Note this flag", "the page keeps saying what was asked"
    assert run["from_race"] == {"id": race["id"], "run": race["through"], "plan_hash": lane["plan_hash"]}
    assert run["plan_hash"] == lane["plan_hash"]
    assert "race" not in run, "this run is not a lane, so it can be approved"
    # This plan is inside the auto-apply list, and a person still decides, because that's what the button says.
    assert next(a for a in run["attempts"] if a["n"] == run["final_attempt"])["budget"]["within"] is True
    assert run["status"] == "awaiting_approval"
    view = client.get(f"/api/runs/{run['id']}").json()
    assert view["challenge"]["plan_hash"] == lane["plan_hash"]
    assert api.run_view(run, "reviewer")["can"]["approve"] is True


async def test_steps_that_are_not_that_plan_are_refused(svc, client):
    race, _ = await finished_race(svc)
    res = client.post("/api/runs", json={"steps": [{"type": "sql", "cmd": "DROP TABLE users"}], "from_race": race["id"]})
    assert res.status_code == 409 and "not the plan" in res.json()["detail"]


async def test_a_lane_with_nothing_to_approve_offers_nothing(svc, client):
    race, lane = await finished_race(svc)
    lane["status"] = "blocked"
    svc.store.save_run(lane)
    res = client.post("/api/runs", json={"steps": steps_of(lane), "from_race": race["id"]})
    assert res.status_code == 409 and "no plan" in res.json()["detail"]
    assert client.post("/api/runs", json={"steps": steps_of(lane), "from_race": "nope"}).status_code == 404


async def test_rehearse_again_stays_linked_to_the_race(svc, client):
    race, lane = await finished_race(svc)
    hold_runs(svc, client)
    first = client.post("/api/runs", json={"steps": steps_of(lane), "from_race": race["id"]}).json()["id"]
    await drive(svc, client)
    again = client.post(f"/api/runs/{first}/rehearse-again").json()["id"]
    await drive(svc, client)
    assert svc.store.get_run(again)["from_race"]["id"] == race["id"]
    assert svc.store.get_run(again)["status"] == "awaiting_approval"


# ------------------------------------------------------------------ the drift demo


def run_with(touched, tables=None, snapshot=None, **report):
    final = {
        "n": 1, "verdict": "passed", "report": {"tables": tables or [], **report},
        "rehearsal": {"result": {"touched_tables": touched}},
    }
    return {"id": "r", "status": "approved", "requester": "judge", "target_id": DEMO_TARGET_ID, "final_attempt": 1, "attempts": [final], "snapshot": {"tables": snapshot if snapshot is not None else {t: {"rows": 10} for t in touched}}}


def test_the_write_goes_to_a_table_the_plan_touches():
    assert api.drift_view(run_with(["sessions"]))["table"] == "sessions"
    assert api.drift_view(run_with(["sessions"]))["caught_with_check_off"] is True


def test_users_stays_the_write_when_the_plan_touches_it():
    assert api.drift_view(run_with(["invoices", "users"]))["table"] == "users"


def test_a_table_the_plan_drops_is_only_caught_with_the_check_on():
    view = api.drift_view(run_with(["orders_tmp"], tables=[{"table": "orders_tmp", "dropped": True}]))
    assert view["table"] == "orders_tmp" and view["caught_with_check_off"] is False


def test_a_table_that_keeps_its_rows_is_preferred_over_one_dropped():
    view = api.drift_view(run_with(["orders_tmp", "sessions"], tables=[{"table": "orders_tmp", "dropped": True}]))
    assert view["table"] == "sessions" and view["caught_with_check_off"] is True


def test_no_table_to_write_to_says_why():
    created = api.drift_view(run_with(["brand_new"], snapshot={"users": {"rows": 10}}))
    assert created["table"] is None and "no table that existed" in created["why"]
    empty = api.drift_view(run_with(["job_logs_archive"], snapshot={"job_logs_archive": {"rows": 0}}))
    assert empty["table"] is None and "no rows" in empty["why"]


def test_a_host_run_is_left_to_the_host_write():
    assert api.drift_view(run_with([], kind="host")) == {"host": True}


def test_the_drift_route_refuses_when_there_is_no_table_to_change(svc, client):
    run = {**run_with(["brand_new"], snapshot={"users": {"rows": 10}}), "id": "rnone", "created_at": time.time(), "attempts": run_with(["brand_new"])["attempts"]}
    svc.store.save_run(run)
    res = client.post("/api/demo/drift", params={"run_id": "rnone"})
    assert res.status_code == 409 and "no table" in res.json()["detail"]
    assert client.post("/api/demo/drift", params={"run_id": "missing"}).status_code == 404


@pytest.fixture()
def demo_db(prod_dsn):
    from demo.seed import seed

    u = urlparse(prod_dsn)
    admin = dict(host=u.hostname, port=u.port, user=u.username, password=u.password, dbname="postgres", sslmode="disable")
    name = "t_ux_drift"
    with psycopg.connect(**admin, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")
        c.execute(f"CREATE DATABASE {name}")
    kw = {**admin, "dbname": name}
    with psycopg.connect(**kw) as c:
        seed(c, scale=0.05)
        c.commit()
    yield kw
    with psycopg.connect(**admin, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


@pytest.mark.prod
def test_the_write_changes_any_table_that_has_rows_so_the_drift_check_sees_it(demo_db):
    with psycopg.connect(**demo_db) as c:
        cur = c.cursor()
        cur.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1")
        tables = [r[0] for r in cur.fetchall()]
        before = txrun.table_checksums(cur, tables)
        c.commit()
        written = []
        for t in tables:
            if not before[t]["rows"] or t == "users":
                continue
            api.copy_one_row(c, t)
            c.commit()
            written.append(t)
        cur = c.cursor()
        after = txrun.table_checksums(cur, tables)
    assert {"sessions", "orders_tmp", "feature_flags", "products", "invoices"} <= set(written)
    for t in written:
        assert after[t]["rows"] == before[t]["rows"] + 1 and after[t]["hash"] != before[t]["hash"], t


@pytest.mark.prod
def test_the_write_is_caught_with_the_drift_check_on_and_off(demo_db):
    """The same real apply path, on a plan that doesn't touch users. Before this fix the write went to users and the apply committed."""
    from control.apply import apply_plan
    from control.snapshot import ProdConn, fingerprint

    kw = demo_db
    conn = ProdConn(kw["host"], str(kw["port"]), kw["user"], kw["password"], kw["dbname"], "disable")
    steps = [{"statements": ["DELETE FROM sessions WHERE id % 2 = 0"]}]

    def rehearse():
        with psycopg.connect(**kw) as c:
            cur = c.cursor()
            txrun.run_statements(c, cur, steps)
            columns = txrun.table_columns(cur)
            out = {"xact_counts": txrun.xact_counts(cur), "schema_fingerprint_after": txrun.sha256_json(txrun.schema_state(cur)), "touched_tables": ["sessions"], "content_after": txrun.content_hashes(cur, {"sessions": columns["sessions"]})}
            c.rollback()
        return out

    expected, tables = rehearse(), fingerprint(conn)["tables"]
    with psycopg.connect(**kw) as c:
        api.copy_one_row(c, "sessions")
        c.commit()
    assert apply_plan(conn, steps, [], expected, tables, check_drift=True)["outcome"] == "drift_detected"
    assert apply_plan(conn, steps, [], expected, tables, check_drift=False)["outcome"] == "rolled_back"


# ------------------------------------------------------------------ expired


def waiting(**kw):
    return {"id": "r1", "status": "awaiting_approval", "requester": "judge", "target_id": DEMO_TARGET_ID, "plan_hash": "p", "guardrails_hash": "g", "report_hash": "h", "approval_nonce": "n", "approval_expires_at": time.time() - 5, "attempts": [], "created_at": time.time(), **kw}


def test_a_closed_window_is_expired_and_can_only_be_rehearsed_again():
    view = api.run_view(waiting(), "reviewer")
    assert view["expired"] is True and "challenge" not in view
    assert view["can"] == {"approve": False, "approve_blocked_reason": None, "apply": False, "rehearse_again": True}


def test_an_open_window_is_not_expired():
    view = api.run_view(waiting(approval_expires_at=time.time() + 60), "reviewer")
    assert view["expired"] is False and view["challenge"]["plan_hash"] == "p"
    assert view["can"]["approve"] is True and view["can"]["rehearse_again"] is False


def test_a_lane_never_expires_because_it_was_never_on_offer():
    view = api.run_view(waiting(race={"id": "x", "lane": "through"}), "reviewer")
    assert view["expired"] is False and view["can"]["rehearse_again"] is False


def test_the_list_says_expired_and_names_a_lane():
    assert api.run_summary(waiting())["expired"] is True
    assert api.run_summary(waiting(race={"id": "x", "lane": "through"}))["race_lane"] == "through"


# ------------------------------------------------------------------ a refusal is not an error


def refused_run(status="blocked", steps=(), summary="I won't drop every table.", verdict="invalid_plan"):
    return {"id": "r", "status": status, "requester": "judge", "target_id": DEMO_TARGET_ID, "final_attempt": 1, "attempts": [{"n": 1, "verdict": verdict, "error": "a plan needs at least one step", "plan": {"steps": list(steps), "summary": summary}}]}


def test_no_steps_is_a_refusal_with_the_agents_reason():
    assert api.agent_refusal(refused_run()) == {"reason": "I won't drop every table."}
    assert api.agent_refusal(refused_run(summary="")) == {"reason": None}


def test_a_select_that_says_it_refuses_is_a_refusal():
    assert api.agent_refusal(refused_run("no_change", [{"cmd": "SELECT 1 AS refused;"}], "", "passed")) == {"reason": None}
    assert api.agent_refusal(refused_run("no_change", [{"cmd": "SELECT 1 AS request_rejected"}], "Request denied.", "passed")) == {"reason": "Request denied."}


@pytest.mark.parametrize("cmd,summary", [("SELECT count(*) FROM users", "Counts the active accounts. It won't change anything."), ("SELECT 1", "Checks the connection")])
def test_an_honest_read_is_not_a_refusal(cmd, summary):
    assert api.agent_refusal(refused_run("no_change", [{"cmd": cmd}], summary, "passed")) is None


def test_a_plan_something_stopped_is_not_a_refusal():
    assert api.agent_refusal(refused_run(steps=[{"cmd": "DROP TABLE users"}], verdict="blocked_by_gate")) is None


# ------------------------------------------------------------------ terminal codes


def test_terminal_codes_leave_messages_and_not_plans():
    bad = "could not parse DELEET FORM \x1b[4musers\x1b[0m"
    run = {
        "id": "r", "status": "blocked", "requester": "judge", "target_id": DEMO_TARGET_ID, "blocked_reason": bad, "final_attempt": 1,
        "attempts": [{"n": 1, "verdict": "blocked_by_gate", "error": bad, "plan": {"steps": [{"type": "sql", "cmd": "SELECT '\x1b[4m'"}]}, "gate": {"verdict": "block", "findings": [{"rule": "parse", "reason": bad}]}}],
    }
    view = api.run_view(run, "judge")
    assert view["blocked_reason"] == "could not parse DELEET FORM users"
    assert view["final"]["error"] == "could not parse DELEET FORM users"
    assert view["final"]["gate"]["findings"][0]["reason"] == "could not parse DELEET FORM users"
    assert view["final"]["plan"]["steps"][0]["cmd"] == "SELECT '\x1b[4m'", "the person approving has to see what will run"
    assert "\x1b" in run["blocked_reason"], "the stored record stays as it was"


# ------------------------------------------------------------------ the feed


def own(run_id, status="applied", task="Mark trial users as expired", **kw):
    return {"id": run_id, "status": status, "requester": "judge", "target_id": DEMO_TARGET_ID, "task": task, "created_at": time.time(), "attempts": [], **kw}


def test_the_feed_is_my_runs_and_examples_and_not_a_strangers_text(svc, client):
    store = svc.store
    store.save_run(own("rmine", task="mine, typed by me"))
    store.save_run(own("rstranger", task="something rude a stranger typed", approval={"kind": "human"}))
    store.save_run(own("rgood", approval={"kind": "human"}))
    store.save_run(own("rrolled", status="rolled_back"))
    body = client.get("/api/runs/feed", params={"ids": "rmine,missing"}).json()
    assert [r["id"] for r in body["mine"]] == ["rmine"]
    assert {r["id"] for r in body["examples"]} == {"rgood", "rrolled"}
    assert all(r["example"] for r in body["examples"])
    assert "rstranger" not in json.dumps(body)


def test_a_plan_is_only_an_example_when_it_is_one_of_ours():
    assert hero._is_own_example({"submitted_steps": [{"cmd": "UPDATE users SET status = 'suspended' WHERE last_login_at < now() - interval '2 years'"}]})
    assert not hero._is_own_example({"submitted_steps": [{"cmd": "UPDATE users SET full_name = 'rude'"}]})


def test_the_examples_list_matches_the_buttons_on_the_site():
    pages = (ROOT / "web/src/pages/Home.tsx").read_text() + (ROOT / "web/src/pages/Race.tsx").read_text()
    for text in hero.OWN_TASKS | hero.OWN_PLANS:
        assert text in pages or text.replace("'", "\\'") in pages, text


# ------------------------------------------------------------------ public pages


def test_market_is_public_and_the_ceiling_is_called_a_ceiling():
    api.app.dependency_overrides.clear()
    data = TestClient(api.app).get("/api/market").json()
    assert data["derived"]["first_target_pct"] == 1
    assert "ceiling" in data["derived"]["sam_how"].lower()


def test_the_cover_is_served_for_link_previews():
    res = TestClient(api.app).get("/cover.png")
    assert res.status_code == 200 and res.headers["content-type"] == "image/png"


def test_the_preview_image_is_an_absolute_url_when_the_site_knows_its_address(monkeypatch, tmp_path):
    (tmp_path / "index.html").write_text('<meta property="og:image" content="/cover.png" />')
    monkeypatch.setattr(api, "WEB_DIST", tmp_path)
    monkeypatch.setattr(api, "PUBLIC_URL", "https://example.test/")
    assert 'content="https://example.test/cover.png"' in api.index_html()
    monkeypatch.setattr(api, "PUBLIC_URL", "")
    assert 'content="/cover.png"' in api.index_html()


def test_the_replay_receipt_says_it_was_a_separate_test():
    api.app.dependency_overrides.clear()
    items = TestClient(api.app).get("/api/receipts").json()["items"]
    replay = next((i for i in items if "replayed against" in i["claim"]), None)
    if replay is None:
        pytest.skip("no gauntlet measurement here")
    rules = json.loads((ROOT / "bench/gauntlet.json").read_text())["replay"]["guardrails"]
    assert f"in a separate test with {rules} rules" in replay["claim"]


# ------------------------------------------------------------------ the CLI, in one line


def fake(handler):
    return lambda: httpx.Client(base_url="http://x", transport=httpx.MockTransport(handler))


def one_line(capsys):
    err = capsys.readouterr().err
    assert len(err.strip().splitlines()) == 1 and "Traceback" not in err, err
    return err


def test_login_guest_prints_a_token(monkeypatch, capsys):
    def handler(request):
        assert request.url.path == "/api/demo/enter"
        return httpx.Response(200, json={"token": "tok123", "username": "judge"})

    monkeypatch.setattr(cli, "client", fake(handler))
    assert cli.main(["login", "--guest"]) == 0
    assert capsys.readouterr().out.strip() == "tok123"


def test_login_guest_on_a_deployment_with_no_open_demo(monkeypatch, capsys):
    monkeypatch.setattr(cli, "client", fake(lambda r: httpx.Response(403, json={"detail": "this deployment has no open demo"})))
    assert cli.main(["login", "--guest"]) == 1
    assert "no open demo" in one_line(capsys)


def test_login_with_no_name_says_how(monkeypatch, capsys):
    monkeypatch.setattr(cli, "client", fake(lambda r: pytest.fail("no request needed")))
    assert cli.main(["login"]) == 1
    assert "--guest" in one_line(capsys)


def test_login_with_no_terminal_says_how(monkeypatch, capsys):
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO(""))
    monkeypatch.setattr(cli, "client", fake(lambda r: pytest.fail("no request needed")))
    assert cli.main(["login", "judge"]) == 1
    assert "--guest" in one_line(capsys)


def test_a_piped_password_still_works(monkeypatch, capsys):
    monkeypatch.setattr(cli.sys, "stdin", io.StringIO("hunter2\n"))

    def handler(request):
        assert json.loads(request.content) == {"username": "judge", "password": "hunter2"}
        return httpx.Response(200, json={"token": "tok456"})

    monkeypatch.setattr(cli, "client", fake(handler))
    assert cli.main(["login", "judge"]) == 0
    assert capsys.readouterr().out.strip() == "tok456"


def test_a_missing_file_is_one_line(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(cli, "client", fake(lambda r: pytest.fail("no request needed")))
    assert cli.main(["rehearse", str(tmp_path / "nope.sql")]) == 1
    assert "can't read" in one_line(capsys)


def test_a_refused_apply_gives_the_servers_reason(monkeypatch, capsys):
    monkeypatch.setattr(cli, "client", fake(lambda r: httpx.Response(409, json={"detail": "this run has no approval yet"})))
    assert cli.main(["apply", "r1"]) == 1
    err = one_line(capsys)
    assert "409" in err and "no approval yet" in err


def test_no_token_says_how_to_get_one(monkeypatch, capsys):
    monkeypatch.setattr(cli, "client", fake(lambda r: httpx.Response(401, json={"detail": "not signed in"})))
    assert cli.main(["status", "r1"]) == 1
    assert "login --guest" in one_line(capsys)


def test_a_server_that_isnt_there_is_one_line(monkeypatch, capsys):
    def down(request):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(cli, "client", fake(down))
    assert cli.main(["status", "r1"]) == 1
    assert "can't reach" in one_line(capsys)


def test_runs_in_flight_at_startup_are_marked_interrupted():
    from control import api

    class Store:
        def __init__(self):
            self.runs = [{"id": "a", "status": "rehearsing"}, {"id": "b", "status": "awaiting_approval"}, {"id": "c", "status": "applying"}]
            self.saved = []

        def list_runs(self, limit):
            return self.runs

        def save_run(self, run):
            self.saved.append(run["id"])

    s = Store()
    assert api.mark_interrupted(s) == 2
    assert s.saved == ["a", "c"]
    assert s.runs[0]["status"] == "error" and "restarted" in s.runs[0]["error"]
    assert s.runs[1]["status"] == "awaiting_approval"
