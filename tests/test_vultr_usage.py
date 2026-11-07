"""bench/vultr_usage.py and the public route that serves what it wrote. No network: the Vultr calls aren't exercised here."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from bench import vultr_usage as vu
from control import api, settings


def write(path, doc):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc) if not isinstance(doc, list) else "\n".join(json.dumps(r) for r in doc) + "\n")


def test_the_vultr_route_is_public_and_prefers_the_published_file(monkeypatch, tmp_path):
    api.app.dependency_overrides.clear()
    monkeypatch.setattr(api, "ROOT", tmp_path)
    monkeypatch.setattr(api, "PUBLISHED", tmp_path / "bench" / "published")
    client = TestClient(api.app)
    assert client.get("/api/vultr").json() == {}
    write(tmp_path / "bench" / "vultr.json", {"at": "working copy"})
    assert client.get("/api/vultr").json() == {"at": "working copy"}
    write(tmp_path / "bench" / "published" / "vultr.json", {"at": "published"})
    res = client.get("/api/vultr")
    assert res.status_code == 200 and res.json() == {"at": "published"}


SHADOW = {
    "task": "t1", "mode": "shadow_run", "target": "postgres", "model": "qwen3.8-27b", "outcome": "held_for_human",
    "attempts": [{"n": 1, "verdict": "failed_guardrails"}, {"n": 2, "verdict": "evaded_rule"}, {"n": 3, "verdict": "passed"}],
    "verdicts": ["failed_guardrails", "evaded_rule", "passed"], "report_totals": {"rows_changed": 3},
    "rehearsal_ms": [3000.0, 3200.0, 3400.0], "clone_boot_ms": [1000.0, 1100.0, 1200.0], "contained": [True, True, True],
    "evasions": [{"n": 2}, {"n": 3}], "prompt_tokens": 1000, "completion_tokens": 200, "cost_usd": 0.0005,
    "usage_by_phase": {"planner": 0.0003, "explainer": 0.00015, "second_opinion": 0.00005},
}
DIRECT = {
    "task": "t2", "mode": "direct", "target": "host", "model": "qwen3.8-27b", "outcome": "executed",
    "attempts": [{"n": 1, "verdict": "executed"}], "verdicts": ["executed"], "prompt_tokens": 1000, "completion_tokens": 100,
    "cost_usd": 0.00025, "usage_by_phase": {"planner": 0.00025},
}


def test_only_runs_of_the_final_benchmarks_code_are_counted(tmp_path):
    write(tmp_path / "results.json", {"code_sha256": "a" * 64, "model": "qwen3.8-27b", "runs": 2, "status": "measured"})
    write(tmp_path / "runs.jsonl", [SHADOW, DIRECT])
    write(tmp_path / "results.old.json", {"code_sha256": "b" * 64, "model": "qwen3.8-27b", "label": "old"})
    write(tmp_path / "runs.old.jsonl", [DIRECT, DIRECT, DIRECT])
    info = vu.benchmark_files(tmp_path)
    assert [f["label"] for f in info["files"]] == ["main"]
    assert [(f["label"], f["why"]) for f in info["skipped"]] == [("old", "measured with different code")]
    pairs = vu.load_runs(info["files"])
    assert len(pairs) == 2

    inf = vu.inference(pairs, {"qwen3.8-27b": (1.5e-7, 1e-6)})
    assert (inf["runs"], inf["prompt_tokens"], inf["completion_tokens"], inf["tokens"]) == (2, 2000, 300, 2300)
    assert inf["cost_usd"] == pytest.approx(0.00075)
    by_model = {m["model"]: m for m in inf["by_model"]}
    # Each phase goes to the model control/settings.py names for it; the planner is the run's own.
    assert by_model[settings.SECOND_OPINION_MODEL]["phases"] == ["second_opinion"]
    assert "explainer" in by_model[settings.EXPLAINER_MODEL]["phases"]
    assert inf["calls_at_least"]["planner"] == 4
    assert inf["calls_at_least"]["explainer"] == 3
    assert inf["calls_at_least"]["evasion_reader"] == 2
    # Only the direct run used a single model, and today's price reproduces its recorded cost.
    assert inf["price_check"]["runs_checked"] == 1
    assert inf["price_check"]["max_abs_diff_usd"] == pytest.approx(0, abs=1e-9)

    vm = vu.microvms(pairs, tmp_path)
    # Three first rehearsals; the evaded attempt and the final passed attempt that changed rows each ran on a second clone.
    assert (vm["rehearsals"], vm["reproductions"], vm["total"]) == (3, 2, 5)
    assert vm["clone_boot_ms"] == {"p50": 1100.0, "p95": 1200.0, "n": 3}
    assert (vm["containment_complete"], vm["containment_incomplete"]) == (3, 0)

    db = vu.benchmark_databases(pairs)
    assert (db["databases_created"], db["dropped"], db["drop_failed"]) == (1, 1, 0)


def test_a_passed_plan_that_changed_nothing_never_ran_on_a_second_clone():
    run = {**SHADOW, "attempts": [{"n": 1, "verdict": "passed"}], "report_totals": {"rows_changed": 0, "ddl_commands": 0}}
    assert vu.reproductions_in(run) == 0


def test_a_failing_source_is_recorded_with_secrets_removed_and_the_rest_carries_on(monkeypatch):
    monkeypatch.setenv("VULTR_API_KEY", "not-a-real-key-0123456789")

    def boom():
        raise RuntimeError("GET /v2/account failed for not-a-real-key-0123456789")

    errors: dict = {}
    assert vu.section(errors, "spend", boom) is None
    assert vu.section(errors, "fine", lambda: 7) == 7
    assert list(errors) == ["spend"]
    assert "not-a-real-key-0123456789" not in errors["spend"] and "[redacted]" in errors["spend"]


def test_it_refuses_to_write_a_file_that_would_hold_a_secret(monkeypatch, tmp_path):
    monkeypatch.setenv("SHADOWRUN_S3_SECRET_KEY", "not-a-real-secret-0123456789")
    monkeypatch.setattr(vu, "OUT", tmp_path / "vultr.json")
    monkeypatch.setattr(vu, "build", lambda: {"errors": {}, "oops": "not-a-real-secret-0123456789"})
    with pytest.raises(SystemExit):
        vu.main()
    assert not (tmp_path / "vultr.json").exists()
