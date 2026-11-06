"""A race starts two real runs on one snapshot, and neither of them can ever reach prod."""
import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from control import agent, api, approvals, auth, service, settings
from control.approvals import ApprovalError
from control.service import DEMO_TARGET_ID, Service
from control.store import Store


def rehearsal(guard_passed=True, ok=True, error=None):
    return {
        "contained": True, "sandbox_error": None, "phases": {"total_ms": 1},
        "result": {
            "ok": ok, "error": error, "changes": [{"step": 1, "table": "feature_flags", "op": "UPDATE", "via": "direct", "rows": 1}],
            "table_rows_before": {"feature_flags": 4}, "table_rows_after": {"feature_flags": 4}, "foreign_keys": [], "ddl": [], "schema_diff": [], "samples": {},
            "xact_counts": {"feature_flags": {"ins": 0, "upd": 1, "del": 0}}, "changed_columns": {"feature_flags": {"note": 1}},
            "guardrails": [{"id": "g", "name": "guard", "passed": guard_passed, "violations": [], "violation_count_capped": 0 if guard_passed else 3}],
            "schema_fingerprint_after": "s", "sequences_moved": [],
        },
    }


class FakeRunner:
    """Every rehearsal comes back the same unless a test says otherwise."""

    def __init__(self, rec=None):
        self.rec = rec or rehearsal()
        self.rehearsals = 0

    async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
        self.rehearsals += 1
        return self.rec


def plan_writes_a_note(*_a, **_k):
    # Inside the demo's auto-apply list, so a normal run would go straight to prod with no person.
    return {"steps": [{"type": "sql", "cmd": "UPDATE feature_flags SET note = 'x' WHERE key = 'beta_search'", "why": "asked"}], "summary": "note"}


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
    snapshots = []

    async def ensure_snapshot(target):
        snapshots.append(target["id"])
        return {"snapshot_id": "s1", "digest": "d1", "cached": True, "timing": {}, "tables": {}}

    async def inspection_for(target, snapshot_id):
        return {"tables": [], "foreign_keys": []}

    async def scan_suspect_rows(snapshot_id):
        return []

    async def prod_check(run, target, snap):
        run["prod_check"] = {"before": "d1", "after": "d1", "unchanged": True}

    s.ensure_snapshot, s.inspection_for, s.scan_suspect_rows, s._prod_check = ensure_snapshot, inspection_for, scan_suspect_rows, prod_check
    s.snapshots = snapshots
    # Nothing in this file may ever get as far as writing to prod.
    monkeypatch.setattr(service, "apply_plan", lambda *a, **k: pytest.fail("a race reached apply_plan"))
    monkeypatch.setattr(agent, "call_planner", plan_writes_a_note)
    monkeypatch.setattr(agent, "explain", lambda *a, **k: {"text": "x", "numbers_verified": True})
    monkeypatch.setattr(service, "second_opinion", lambda *a, **k: {"model": "m", "verdict": "does_it", "left_out": "", "added": ""})
    return s


async def finish(svc, task="Note this flag"):
    race = svc.start_race(task, "judge")
    while svc._tasks:
        await asyncio.gather(*list(svc._tasks))
    return race, svc.store.get_run(race["alone"]), svc.store.get_run(race["through"])


# ------------------------------------------------------------------ neither lane can reach prod


async def test_both_lanes_only_rehearse(svc):
    _, alone, through = await finish(svc)
    assert alone["rehearse_only"] and through["rehearse_only"]
    assert alone["race"]["lane"] == "alone" and through["race"]["lane"] == "through"
    assert alone["source"] == through["source"] == "race"


async def test_a_plan_inside_the_auto_apply_list_still_does_not_apply(svc):
    """This is the plan that goes straight to prod in a normal run."""
    _, alone, through = await finish(svc)
    assert through["attempts"][-1]["budget"]["within"] is True
    assert through["status"] == "awaiting_approval"
    assert alone["status"] == "blocked"
    assert "approval" not in through and "approval" not in alone
    assert "apply" not in through and "apply" not in alone


async def test_the_control_is_real_a_normal_run_of_that_plan_would_apply(svc, monkeypatch):
    """So the test above fails if the plan ever stops being one that auto-applies."""
    applied = []

    async def fake_apply(run_id, actor, drift_check=True):
        applied.append(run_id)

    monkeypatch.setattr(svc, "apply", fake_apply)
    run = svc.new_run(DEMO_TARGET_ID, "judge", "Note this flag", None, "web")
    svc.start(run)
    while svc._tasks:
        await asyncio.gather(*list(svc._tasks))
    assert applied == [run["id"]]


@pytest.mark.parametrize("lane", ["alone", "through"])
async def test_neither_lane_can_be_approved_by_someone_else(svc, lane):
    race, *_ = await finish(svc)
    run = svc.store.get_run(race[lane])
    presented = {"plan_hash": run.get("plan_hash"), "guardrails_hash": run.get("guardrails_hash"), "report_hash": run.get("report_hash"), "nonce": run.get("approval_nonce")}
    with pytest.raises(ApprovalError) as e:
        svc.approve(race[lane], "reviewer", presented)
    assert e.value.status == 409 and "race" in e.value.message
    assert svc.store.get_run(race[lane])["status"] == run["status"]


@pytest.mark.parametrize("lane", ["alone", "through"])
async def test_neither_lane_applies_even_with_a_forged_approval(svc, lane):
    race, *_ = await finish(svc)
    run = svc.store.get_run(race[lane])
    run["status"] = "approved"
    approvals.open_challenge(run)
    run["approval"] = approvals.grant_auto({**run, "plan_hash": run.get("plan_hash") or "p", "report_hash": run.get("report_hash") or "r"})
    svc.store.save_run(run)
    with pytest.raises(ApprovalError) as e:
        await svc.apply(race[lane], actor="reviewer")
    assert e.value.status == 409 and "race" in e.value.message
    assert svc.store.get_run(race[lane])["status"] == "approved"


async def test_an_agent_cant_release_a_lane_through_mcp(svc):
    race, _, through = await finish(svc)
    assert through["attempts"][-1]["budget"]["within"] is True
    assert svc.release_within_budget(race["through"]) is None
    # Even a record that claimed to come through MCP stops at apply.
    through["source"] = "mcp"
    svc.store.save_run(through)
    released = svc.release_within_budget(race["through"])
    assert released is not None
    with pytest.raises(ApprovalError):
        await svc.apply(race["through"], actor="mcp:judge")


@pytest.mark.parametrize("lane", ["alone", "through"])
async def test_a_lanes_plan_cant_be_carried_into_a_normal_run(svc, lane):
    race, *_ = await finish(svc)
    with pytest.raises(ValueError):
        svc.rehearse_again(race[lane], "judge")


async def test_the_page_is_told_it_cant_approve_or_apply(svc):
    _, alone, through = await finish(svc)
    view = api.run_view(through, "reviewer")
    assert view["status"] == "awaiting_approval"
    assert view["can"]["approve"] is False and view["can"]["apply"] is False and view["can"]["approve_blocked_reason"] is None
    assert "challenge" not in view
    assert api.run_view({**alone, "status": "approved"}, "reviewer")["can"]["apply"] is False


# ------------------------------------------------------------------ what each lane is


async def test_both_lanes_use_one_snapshot_and_it_is_taken_once_up_front(svc):
    _, alone, through = await finish(svc)
    assert alone["snapshot"]["snapshot_id"] == through["snapshot"]["snapshot_id"] == "s1"
    # Once ahead of the lanes, so two lanes on a cold cache don't each dump prod, then once each to find it.
    assert len(svc.snapshots) == 3


async def test_the_left_lane_stays_refused_even_when_its_plan_passes_every_check(svc):
    _, alone, _ = await finish(svc)
    assert alone["attempts"][0]["verdict"] == "passed"
    assert alone["status"] == "blocked" and "can't be approved" in alone["blocked_reason"]
    assert "report_hash" not in alone and "approval_nonce" not in alone


async def test_the_left_lane_spends_nothing_on_commentary(svc, monkeypatch):
    called = []
    monkeypatch.setattr(service, "second_opinion", lambda *a, **k: called.append("second") or {"verdict": "does_it"})
    monkeypatch.setattr(agent, "explain", lambda *a, **k: called.append("explain") or {"text": "x"})
    run = svc.new_run(DEMO_TARGET_ID, "judge", "Note this flag", None, "race")
    run.update(rehearse_only=True, race={"id": "r", "lane": "alone"}, measure_blocked=True, single_plan=True)
    svc.store.save_run(run)
    svc.start(run)
    while svc._tasks:
        await asyncio.gather(*list(svc._tasks))
    assert called == []


async def test_the_right_lane_retries_with_what_was_measured(svc, monkeypatch):
    seen = []

    def planner(task, schema, kind, feedback, read_results=None, model=None):
        seen.append(list(feedback))
        return plan_writes_a_note()

    monkeypatch.setattr(agent, "call_planner", planner)
    results = [rehearsal(guard_passed=False), rehearsal(guard_passed=True), rehearsal(guard_passed=False), rehearsal(guard_passed=True)]

    class Scripted(FakeRunner):
        async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
            if run_id.endswith("b"):  # the second clone agrees with the first
                return self.last
            self.last = results.pop(0)
            return self.last

    svc.runner = Scripted()
    run = svc.new_run(DEMO_TARGET_ID, "judge", "Note this flag", None, "race")
    run.update(rehearse_only=True, race={"id": "r", "lane": "through"})
    svc.store.save_run(run)
    svc.start(run)
    while svc._tasks:
        await asyncio.gather(*list(svc._tasks))
    final = svc.store.get_run(run["id"])
    assert [a["verdict"] for a in final["attempts"]] == ["failed_guardrails", "passed"]
    assert seen[0] == [] and "Measured on the clone" in seen[1][0]
    assert final["status"] == "awaiting_approval"


async def test_a_lane_that_fails_says_so_and_the_other_still_finishes(svc):
    """The lanes share nothing but the snapshot, so one blowing up can't stop the other."""
    original = svc.inspection_for
    calls = []

    async def inspection_for(target, snapshot_id):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("inspect failed")
        return await original(target, snapshot_id)

    svc.inspection_for = inspection_for
    _, alone, through = await finish(svc)
    statuses = sorted([alone["status"], through["status"]])
    assert "error" in statuses and statuses != ["error", "error"]


async def test_a_failed_snapshot_ends_both_lanes_with_an_error(svc):
    async def broken(target):
        raise RuntimeError("prod is down")

    svc.ensure_snapshot = broken
    _, alone, through = await finish(svc)
    assert alone["status"] == through["status"] == "error"
    assert "prod is down" in alone["error"]


# ------------------------------------------------------------------ one plan only


async def loop(runner, **kw):
    return await agent.run_loop(
        task="do it", fixed_steps=None, target={"id": "t", "kind": "postgres", "budget": {}}, guardrails=[{"id": "g", "name": "guard", "sql": "SELECT 1 WHERE false"}],
        run_id="r", snapshot_id="s", runner=runner, inspection={"tables": [], "foreign_keys": []}, on_event=lambda t, d: None, **kw,
    )


def blocked_then_fine(planned):
    plans = [{"steps": [{"type": "sql", "cmd": "COMMIT; DROP TABLE orders CASCADE", "why": "x"}], "summary": "x"}, plan_writes_a_note()]

    def planner(*_a, **_k):
        planned.append(1)
        return plans[min(len(planned) - 1, 1)]

    return planner


async def test_single_plan_keeps_the_first_plan_even_when_the_gate_refuses_it(monkeypatch):
    planned = []
    monkeypatch.setattr(agent, "call_planner", blocked_then_fine(planned))
    runner = FakeRunner()
    out = await loop(runner, single_plan=True, measure_blocked=True)
    assert len(planned) == 1 and len(out["attempts"]) == 1
    assert out["final"]["verdict"] == "blocked_by_gate"
    assert runner.rehearsals == 1 and out["final"]["report"]["totals"]["rows_changed"] == 1


@pytest.mark.parametrize("rec,verdict", [(rehearsal(guard_passed=False), "failed_guardrails"), (rehearsal(ok=False, error="boom"), "sql_error")])
async def test_single_plan_gets_no_second_try(monkeypatch, rec, verdict):
    planned = []

    def planner(*_a, **_k):
        planned.append(1)
        return plan_writes_a_note()

    monkeypatch.setattr(agent, "call_planner", planner)
    monkeypatch.setattr(agent, "explain", lambda *a, **k: {"text": "x"})
    out = await loop(FakeRunner(rec), single_plan=True, explain_plan=False)
    assert len(planned) == 1 and out["final"]["verdict"] == verdict


async def test_the_default_still_retries_after_a_gate_refusal(monkeypatch):
    """single_plan defaults to off, and the benchmark measures this loop, so this has to stay as it was."""
    planned = []
    monkeypatch.setattr(agent, "call_planner", blocked_then_fine(planned))
    monkeypatch.setattr(agent, "explain", lambda *a, **k: {"text": "x"})
    out = await loop(FakeRunner())
    assert len(planned) == 2 and [a["verdict"] for a in out["attempts"]] == ["blocked_by_gate", "passed"]


# ------------------------------------------------------------------ the route and its limits


@pytest.fixture
def client(svc, monkeypatch):
    api._hits.clear()
    monkeypatch.setattr(api, "svc", lambda: svc)
    monkeypatch.setattr(api, "require_inference_budget", lambda: None)
    started = []
    monkeypatch.setattr(svc, "start_race", lambda task, user: started.append((task, user)) or {"id": "race1", "task": task, "alone": "a", "through": "b"})
    api.app.dependency_overrides[auth.current_user] = lambda: "judge"
    c = TestClient(api.app)
    c.started = started
    yield c
    api.app.dependency_overrides.clear()
    api._hits.clear()


def test_the_route_needs_a_sign_in(svc, monkeypatch):
    monkeypatch.setattr(api, "svc", lambda: svc)
    assert TestClient(api.app).post("/api/race", json={"task": "x"}).status_code == 401
    assert TestClient(api.app).get("/api/race/nope").status_code == 401


def test_the_route_starts_a_race(client):
    r = client.post("/api/race", json={"task": "  Do the thing  "})
    assert r.status_code == 201 and r.json()["alone"] == "a"
    assert client.started == [("Do the thing", "judge")]


@pytest.mark.parametrize("body", [{"task": ""}, {"task": "   "}, {}, {"task": "x" * 2001}])
def test_the_route_refuses_a_bad_task(client, body):
    assert client.post("/api/race", json=body).status_code == 422
    assert client.started == []


def test_2000_characters_is_allowed(client):
    assert client.post("/api/race", json={"task": "x" * 2000}).status_code == 201
    with pytest.raises(ValidationError):
        api.RaceBody(task="x" * 2001)


def test_a_race_counts_as_two_agent_runs(client, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_PER_HOUR", 4)
    assert client.post("/api/race", json={"task": "one"}).status_code == 201
    assert client.post("/api/race", json={"task": "two"}).status_code == 201
    third = client.post("/api/race", json={"task": "three"})
    assert third.status_code == 429 and "agent runs" in third.json()["detail"]
    assert len(client.started) == 2


def test_a_race_needs_room_for_both_lanes_under_the_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_PER_HOUR", 3)
    assert client.post("/api/race", json={"task": "one"}).status_code == 201
    # One slot left, and a race needs two, so nothing starts and the slot isn't used up.
    assert client.post("/api/race", json={"task": "two"}).status_code == 429
    api.limit("judge", "agent runs", settings.RUNS_PER_HOUR)


def test_limits_go_by_address(client, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_PER_HOUR", 2)
    api.client_ip.set("1.1.1.1")
    api.limit("judge", "agent runs", 2, cost=2)
    with pytest.raises(HTTPException):
        api.limit("judge", "agent runs", 2, cost=2)
    api.client_ip.set("2.2.2.2")
    api.limit("judge", "agent runs", 2, cost=2)


def test_limit_with_the_default_cost_is_what_it_was():
    api._hits.clear()
    api.client_ip.set("3.3.3.3")
    api.limit("judge", "plan checks", 2)
    api.limit("judge", "plan checks", 2)
    with pytest.raises(HTTPException):
        api.limit("judge", "plan checks", 2)
    api._hits.clear()


def test_a_busy_runner_refuses_a_race(client, svc, monkeypatch):
    monkeypatch.setattr(settings, "MAX_RUNNING", 3)
    svc._tasks = {1, 2}
    r = client.post("/api/race", json={"task": "x"})
    assert r.status_code == 429 and "busy" in r.json()["detail"]
    assert client.started == []


def test_a_spent_inference_budget_refuses_a_race(client, monkeypatch):
    def spent():
        raise HTTPException(429, "today's inference budget for this demo is used up")

    monkeypatch.setattr(api, "require_inference_budget", spent)
    r = client.post("/api/race", json={"task": "x"})
    assert r.status_code == 429 and "budget" in r.json()["detail"]
    assert client.started == []


def test_a_refused_race_uses_up_no_limit(client, svc, monkeypatch):
    monkeypatch.setattr(settings, "RUNS_PER_HOUR", 2)
    monkeypatch.setattr(settings, "MAX_RUNNING", 1)
    assert client.post("/api/race", json={"task": "x"}).status_code == 429
    monkeypatch.setattr(settings, "MAX_RUNNING", 8)
    assert client.post("/api/race", json={"task": "x"}).status_code == 201


def test_no_demo_database_means_no_race(client, svc, monkeypatch):
    monkeypatch.setattr(svc.store, "get_target", lambda _: None)
    assert client.post("/api/race", json={"task": "x"}).status_code == 404


async def test_a_race_can_be_read_back(svc, monkeypatch):
    monkeypatch.setattr(api, "svc", lambda: svc)
    api.app.dependency_overrides[auth.current_user] = lambda: "judge"
    try:
        race, *_ = await finish(svc, "Read me back")
        c = TestClient(api.app)
        got = c.get(f"/api/race/{race['id']}").json()
        assert got["task"] == "Read me back" and got["alone"] == race["alone"] and got["through"] == race["through"]
        assert c.get("/api/race/nope").status_code == 404
    finally:
        api.app.dependency_overrides.clear()


async def test_a_race_id_cant_read_other_stored_values(svc, monkeypatch):
    monkeypatch.setattr(api, "svc", lambda: svc)
    api.app.dependency_overrides[auth.current_user] = lambda: "judge"
    svc.store.kv_set("undo:r:1", ["secret"])
    try:
        assert TestClient(api.app).get("/api/race/undo:r:1").status_code == 404
    finally:
        api.app.dependency_overrides.clear()
