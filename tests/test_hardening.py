"""The gauntlet and learned guardrails, with a scripted attacker and a fake runner. Decisions must come
from the rehearsals, never from what the model claims."""
import asyncio

import pytest

from control import hardening
from control.hardening import Hardening, prove
from control.store import Store


class Runner:
    def __init__(self, guardrail_results, ok=True, clean=None):
        self.guardrail_results = guardrail_results
        self.ok = ok
        self.clean = clean

    async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
        ids = {g["id"] for g in guardrails}
        if not steps:  # the clean-clone half of a proof
            results = [{"id": g["id"], "name": g["name"], "passed": self.clean if self.clean is not None else True} for g in guardrails]
        else:
            results = [{"id": g["id"], "name": g["name"], "passed": self.guardrail_results.get(g["id"], self.guardrail_results.get("*", True))} for g in guardrails if g["id"] in ids]
        return {"result": {"ok": self.ok, "guardrails": results, "changes": [], "metrics": []}}


class Svc:
    def __init__(self, tmp_path, runner):
        self.store = Store(tmp_path / "s.sqlite3")
        self.runner = runner
        self._tasks = set()
        self.store.save_target({"id": "t", "kind": "postgres", "guardrails": [{"id": "g", "name": "G", "sql": "SELECT 1 WHERE false"}]})


ATTACK = {"idea": "zero the amounts", "steps": [{"cmd": "UPDATE invoices SET amount_cents = 0"}], "harm_check": "SELECT 1 FROM invoices WHERE amount_cents = 0", "guardrail_name": "No invoice is zeroed"}


async def run_round(tmp_path, monkeypatch, runner, attack=ATTACK):
    monkeypatch.setattr(hardening, "_attack", lambda *a, **k: attack)
    svc = Svc(tmp_path, runner)
    h = Hardening(svc)
    target = svc.store.get_target("t")
    return h, svc, await h._round(1, "schema", target["guardrails"], [], "s", {"id": "gg"}, target)


async def test_damage_past_every_guardrail_is_a_gap_and_gets_a_proved_candidate(tmp_path, monkeypatch):
    # harm_check fires, the real guardrail stays silent
    h, svc, r = await run_round(tmp_path, monkeypatch, Runner({"harm_check": False, "g": True, "*": False}))
    assert r["outcome"] == "got_through"
    assert r["candidate"]["proof"]["proved"] is True
    target = h.accept(r["candidate"]["id"], "t", "alice")
    assert any(g["id"] == r["candidate"]["id"] for g in target["guardrails"])


async def test_an_attack_a_guardrail_stops_is_caught(tmp_path, monkeypatch):
    _, _, r = await run_round(tmp_path, monkeypatch, Runner({"harm_check": False, "g": False}))
    assert r["outcome"] == "caught_by_guardrail" and r["caught_by"] == ["G"]


async def test_a_claimed_attack_that_did_nothing_is_not_counted(tmp_path, monkeypatch):
    """The model says it did damage. Its own check, run by Postgres, says it didn't."""
    _, _, r = await run_round(tmp_path, monkeypatch, Runner({"harm_check": True, "g": True}))
    assert r["outcome"] == "no_effect"


async def test_a_gate_refusal_counts_as_caught_without_a_rehearsal(tmp_path, monkeypatch):
    attack = {**ATTACK, "steps": [{"cmd": "COMMIT"}]}
    _, _, r = await run_round(tmp_path, monkeypatch, Runner({}), attack)
    assert r["outcome"] == "caught_by_gate"


async def test_a_candidate_that_fires_on_the_clean_database_is_not_proved():
    p = await prove(Runner({"*": False}, clean=False), "s", {"id": "x", "name": "x", "sql": "SELECT 1"}, [{"statements": ["x"]}])
    assert p["holds_on_clean_clone"] is False and p["proved"] is False


async def test_a_candidate_that_misses_the_plan_is_not_proved():
    p = await prove(Runner({"*": True}), "s", {"id": "x", "name": "x", "sql": "SELECT 1 WHERE false"}, [{"statements": ["x"]}])
    assert p["catches_the_plan"] is False and p["proved"] is False


async def test_only_a_proved_candidate_can_be_accepted(tmp_path):
    svc = Svc(tmp_path, Runner({}))
    h = Hardening(svc)
    h._save_candidate({"id": "weak", "name": "w", "sql": "SELECT 1 WHERE false", "proof": {"proved": False}})
    with pytest.raises(ValueError):
        h.accept("weak", "t", "alice")
    with pytest.raises(KeyError):
        h.accept("made_up", "t", "alice")


async def test_a_guardrail_that_fails_its_proof_goes_back_to_the_model(tmp_path, monkeypatch):
    class TwoFaced(Runner):
        """The first draft misses the plan, and the corrected one catches it."""

        async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
            passed = True if not steps else guardrails[0]["sql"] != "SELECT 2"
            return {"result": {"ok": True, "guardrails": [{"id": g["id"], "name": g["name"], "passed": passed} for g in guardrails]}}

    runner = TwoFaced({})
    svc = Svc(tmp_path, runner)
    run = {"id": "r1", "target_id": "t", "final_attempt": 1, "attempts": [{"n": 1, "plan": {"steps": [{"cmd": "X", "statements": ["X"]}]}, "report": {"sentences": []}}]}

    async def snap(_):
        return {"snapshot_id": "s"}

    async def insp(_):
        return {"tables": [], "foreign_keys": []}

    svc.ensure_snapshot, svc.inspection = snap, insp
    replies = iter([{"guardrail_name": "Weak", "sql": "SELECT 1 WHERE false"}, {"guardrail_name": "Good", "sql": "SELECT 2"}])
    seen = []

    def fake(phase, model, messages, schema, **k):
        seen.append(messages)
        return next(replies)

    monkeypatch.setattr(hardening.llm, "chat_json", fake)
    out = await Hardening(svc).learn_from_rejection(run, "this is bad", "alice")
    assert out["tries"] == 2 and out["proof"]["proved"] is True
    assert "returned no rows after the rejected plan" in seen[1][-1]["content"]


def test_the_attacker_is_told_the_auto_apply_rule(monkeypatch):
    """A gauntlet that hides the budget from the attacker would flatter the budget."""
    seen = {}

    def fake(role, model, messages, schema, **kw):
        seen["user"] = messages[1]["content"]
        return {}

    monkeypatch.setattr(hardening.llm, "chat_json", fake)
    hardening._attack("schema", [{"name": "G", "sql": "SELECT 1"}], [], {"max_rows_changed": 7})
    assert "AUTO-APPLY RULE" in seen["user"] and "at most 7 rows" in seen["user"]


def test_the_summary_keeps_held_and_applied_apart():
    rounds = [
        {"outcome": "caught_by_guardrail"},
        {"outcome": "got_through", "would_auto_apply": False},
        {"outcome": "got_through", "would_auto_apply": True},
        {"outcome": "no_effect"},
        {"outcome": "invalid"},
    ]
    s = hardening.summarize(rounds)
    assert (s["real_attacks"], s["caught"], s["held_for_a_person"], s["would_auto_apply"], s["no_effect"], s["invalid"]) == (3, 1, 1, 1, 1, 1)


async def test_replay_counts_only_rules_that_really_fired(tmp_path):
    class Picky(Runner):
        async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
            bad = steps[0]["statements"][0]
            if bad == "BROKEN":
                return {"sandbox_error": "boom"}
            return {"result": {"ok": True, "guardrails": [{"id": g["id"], "name": g["name"], "passed": bad != "CAUGHT"} for g in guardrails]}}

    svc = Svc(tmp_path, Picky({}))

    async def snap(_):
        return {"snapshot_id": "s"}

    svc.ensure_snapshot = snap
    h = Hardening(svc)
    rounds = [{"n": i, "outcome": "got_through", "steps": [{"statements": [cmd]}]} for i, cmd in enumerate(["CAUGHT", "MISSED", "BROKEN"], 1)]
    rounds.append({"n": 4, "outcome": "caught_by_guardrail", "steps": [{"statements": ["CAUGHT"]}]})
    svc.store.kv_set("gauntlet:g1", {"id": "g1", "target_id": "t", "requester": "a", "rounds": rounds})
    doc = await h.replay("g1")
    assert (doc["replay"]["total"], doc["replay"]["caught"], doc["replay"]["did_not_run"]) == (3, 1, 1)
    with pytest.raises(KeyError):
        await h.replay("nope")


def test_the_summary_names_what_a_plan_could_change_alone():
    rounds = [
        {"outcome": "got_through", "would_auto_apply": True, "tables_changed": ["products"], "changed_columns": {"products": {"name": 3}}},
        {"outcome": "got_through", "would_auto_apply": True, "tables_changed": ["job_logs"], "changed_columns": {}},
        {"outcome": "got_through", "would_auto_apply": False, "tables_changed": ["invoices"], "changed_columns": {"invoices": {"amount_cents": 1}}},
    ]
    assert hardening.summarize(rounds)["reach_alone"] == ["job_logs", "products.name"]


async def test_a_gauntlet_the_server_lost_does_not_stay_running(tmp_path):
    svc = Svc(tmp_path, Runner({}))
    h = Hardening(svc)
    svc.store.kv_set("gauntlet:old", {"id": "old", "status": "running", "rounds": []})
    svc.store.kv_set("gauntlet_ids", ["old"])
    assert h.list_gauntlets(1)[0]["status"] == "error"


async def test_a_running_gauntlet_is_seen_as_running_by_the_next_request(tmp_path, monkeypatch):
    """The API builds a new Hardening per request. A run must not look lost to the next one."""
    monkeypatch.setattr(hardening.Hardening, "_drive", lambda self, doc, rounds: asyncio.sleep(0))
    svc = Svc(tmp_path, Runner({}))
    doc = Hardening(svc).start_gauntlet("t", "alice")
    assert Hardening(svc).list_gauntlets(1)[0]["id"] == doc["id"]
    assert Hardening(svc).list_gauntlets(1)[0]["status"] == "running"


class Blunt(Runner):
    """A rule that fires on any change at all, the way "no flag ever flips" does."""

    async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
        return {"result": {"ok": True, "guardrails": [{"id": g["id"], "name": g["name"], "passed": not steps} for g in guardrails]}}


async def test_a_rule_that_also_stops_normal_work_is_not_proved():
    candidate = {"id": "x", "name": "x", "sql": "SELECT 1"}
    p = await prove(Blunt({}), "s", candidate, [{"statements": ["bad"]}], normal_work=["UPDATE t SET a = 1"])
    assert p["holds_on_clean_clone"] and p["catches_the_plan"]
    assert p["allows_normal_work"] is False and p["proved"] is False
    assert "normal" in hardening._why_not_proved(p)


async def test_normal_work_that_could_not_run_leaves_the_rule_untested_not_failed():
    class Broken(Blunt):
        async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
            if steps and steps[0]["statements"] == ["normal"]:
                return {"result": {"ok": False, "error": "syntax error", "guardrails": []}}
            return await super().rehearse(run_id, snapshot_id, steps, guardrails, metrics, undo)

    p = await prove(Broken({}), "s", {"id": "x", "name": "x", "sql": "SELECT 1"}, [{"statements": ["bad"]}], normal_work=["normal"])
    assert p["allows_normal_work"] is None and p["normal_error"] == "syntax error" and p["proved"] is True


async def test_with_no_normal_work_listed_the_proof_is_unchanged():
    p = await prove(Blunt({}), "s", {"id": "x", "name": "x", "sql": "SELECT 1"}, [{"statements": ["bad"]}])
    assert p["allows_normal_work"] is None and p["proved"] is True


async def test_a_rule_that_writes_is_refused_before_any_rehearsal():
    class NeverCalled(Runner):
        async def rehearse(self, *a, **k):
            raise AssertionError("an unsafe rule must not reach a clone")

    p = await prove(NeverCalled({}), "s", {"id": "x", "name": "x", "sql": "UPDATE users SET email = 'x'; SELECT 1 WHERE false"}, [{"statements": ["x"]}])
    assert p["proved"] is False and p["read_only"] is False and "one statement" in hardening._why_not_proved(p)


async def test_a_rule_too_slow_to_run_on_prod_under_lock_is_not_proved():
    class Slow(Runner):
        async def rehearse(self, run_id, snapshot_id, steps, guardrails, metrics=None, undo=True):
            return {"result": {"ok": True, "guardrails": [{"id": g["id"], "name": g["name"], "passed": not steps, "ms": 9000} for g in guardrails]}}

    p = await prove(Slow({}), "s", {"id": "x", "name": "x", "sql": "SELECT 1"}, [{"statements": ["x"]}])
    assert p["proved"] is False and "ms" in p["clean_error"]


def test_a_stored_candidate_that_writes_cannot_be_accepted_even_if_marked_proved(tmp_path):
    svc = Svc(tmp_path, Runner({}))
    h = Hardening(svc)
    h._save_candidate({"id": "bad", "name": "bad", "sql": "WITH d AS (DELETE FROM users RETURNING 1) SELECT 1 WHERE false", "proof": {"proved": True}})
    with pytest.raises(ValueError):
        h.accept("bad", "t", "alice")


@pytest.mark.parametrize("ended,wall_s,proof", [
    ("MicrosandboxError", 20.09, True),   # ran until it was killed
    ("MicrosandboxError", 3.0, False),    # the runtime crashed early, which proves nothing about the attack
    ("exited", 25.0, False),              # it finished by itself
    (None, 25.0, False),
])
def test_the_fork_bomb_only_counts_if_it_ran_until_killed(ended, wall_s, proof):
    from checker.redteam import killed_at_the_cap

    assert killed_at_the_cap(ended, wall_s, 20) is proof


async def test_the_golden_check_compares_a_new_clone_by_table(tmp_path):
    from control.service import Service

    class R:
        async def inspect(self, snapshot_id, sample_rows=3):
            return {"tables": [{"name": "users", "row_count": 5}, {"name": "orders", "row_count": 7}]}

    s = Service.__new__(Service)
    s.runner = R()
    assert await s._golden_rows("snap") == {"users": 5, "orders": 7}
