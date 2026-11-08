"""The Who pays page's cost to serve is the README's: control/economics.py must give exactly what
scripts/make_readme_table.py economics() gives for the same files, and the API must serve it unchanged."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from control import api, economics

ROOT = Path(__file__).resolve().parent.parent


def readme_script():
    """A fresh copy of the generator, so pointing it at other files can't leak into another test."""
    spec = importlib.util.spec_from_file_location("make_readme_table_for_economics", ROOT / "scripts" / "make_readme_table.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read(path: Path) -> dict | None:
    return json.loads(path.read_text()) if path.exists() else None


def readme_economics(tmp_path: Path, results: dict | None, vultr: dict | None, market: dict | None) -> dict | None:
    """What the README's economics() says when bench/ and docs/ hold exactly these files."""
    m = readme_script()
    (tmp_path / "bench").mkdir(exist_ok=True)
    (tmp_path / "docs").mkdir(exist_ok=True)
    for doc, path in ((results, tmp_path / "bench" / "results.json"), (vultr, tmp_path / "bench" / "vultr.json"), (market, tmp_path / "docs" / "market.json")):
        if doc is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(json.dumps(doc))
    m.ROOT, m.BENCH = tmp_path, tmp_path / "bench"
    return m.economics()


def test_the_repo_files_give_the_readme_answer():
    want = readme_script().economics()
    got = economics.economics(read(ROOT / "bench" / "results.json"), read(ROOT / "bench" / "vultr.json"), read(ROOT / "docs" / "market.json"))
    assert want is not None and got == want


def test_the_published_files_give_the_readme_answer(tmp_path):
    files = [read(ROOT / "bench" / "published" / "results.json"), read(ROOT / "bench" / "published" / "vultr.json"), read(ROOT / "docs" / "market.json")]
    want = readme_economics(tmp_path, *files)
    assert want is not None and economics.economics(*files) == want


def _variants():
    results, vultr, market = read(ROOT / "bench" / "published" / "results.json"), read(ROOT / "bench" / "published" / "vultr.json"), read(ROOT / "docs" / "market.json")

    def with_(doc, change):
        out = copy.deepcopy(doc)
        change(out)
        return out

    def set_price(m):
        m["price"]["usd_per_database_month"] = 350

    def slower(r):
        r["all_risky_and_safe"]["shadow_run"]["seconds_per_task"] = 61.7
        r["all_risky_and_safe"]["shadow_run"]["cost_per_task_usd"] = 0.0121

    def only_dbaas(v):
        v["spend"]["budget"]["resources"] = [x for x in v["spend"]["budget"]["resources"] if "dbaas" in (x.get("plan") or "")]

    def no_cost(r):
        r["all_risky_and_safe"]["shadow_run"]["cost_per_task_usd"] = 0

    def no_vx1_price(r):
        r.pop("vx1_usd_per_hour", None)

    return {
        "another price": (results, vultr, with_(market, set_price)),
        "a slower, dearer run": (with_(results, slower), vultr, market),
        "no fixed resources": (results, with_(vultr, only_dbaas), market),
        "no inference cost": (with_(results, no_cost), vultr, market),
        "no VX1 price": (with_(results, no_vx1_price), vultr, market),
        "no results": (None, vultr, market),
        "no vultr file": (results, None, market),
        "no market file": (results, vultr, None),
    }


@pytest.mark.parametrize("name", list(_variants()))
def test_every_variant_gives_the_readme_answer(tmp_path, name):
    files = _variants()[name]
    assert economics.economics(*files) == readme_economics(tmp_path, *files), name


def test_the_api_serves_the_published_economics_and_size():
    api.app.dependency_overrides.clear()
    data = TestClient(api.app).get("/api/market").json()
    want = economics.economics(api.bench_json("results.json"), api.bench_json("vultr.json"), read(ROOT / "docs" / "market.json"))
    assert want is not None
    assert data["economics"] == json.loads(json.dumps(want))
    assert set(data["economics"]["margin_k"]) == {"1", "2", "3"}
    assert data["served_db_mb"] == economics.served_db_mb(api.bench_json("scale.json"))
    assert data["price"] == read(ROOT / "docs" / "market.json")["price"], "the market file still comes through as it is"


def test_the_size_served_is_the_largest_finished_rehearsal():
    rows = [{"db_mb": 22, "rehearsal_total_s": 3.9, "errors": []}, {"db_mb": 1019, "rehearsal_total_s": 55.6, "errors": []}, {"db_mb": 3610, "rehearsal_total_s": None, "errors": ["timeout"]}]
    assert economics.served_db_mb({"rows": rows}) == 1019
    assert economics.served_db_mb({"rows": rows[2:]}) is None
    assert economics.served_db_mb(None) is None
