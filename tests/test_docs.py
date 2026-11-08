"""The README, its charts and the submission text are generated from the benchmark files. These tests fail when a
committed copy drifts from what the files give, when a link on the page leads nowhere, or when a form text no longer
fits its field, so a number a reader sees can't go stale."""
from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
README = ROOT / "README.md"
# Blocks that read the network (is the demo up), an environment variable (the video link) or pytest itself (the count).
DYNAMIC = {"live", "video", "tests"}


def script(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bench(name: str) -> dict:
    return json.loads((ROOT / "bench" / name).read_text())


def test_every_generated_readme_block_matches_the_benchmark_files():
    m = script("make_readme_table")
    text = README.read_text()
    names = [n for n in m.BLOCKS if n not in DYNAMIC]
    assert m.render(text, names) == text, "the README is stale: run python scripts/make_readme_table.py"


def test_the_readme_has_a_marker_pair_for_every_block():
    m = script("make_readme_table")
    text = README.read_text()
    for name in m.BLOCKS:
        if f"<!-- {name}:start -->" in text:
            assert text.index(f"<!-- {name}:start -->") < text.index(f"<!-- {name}:end -->"), name


def test_the_charts_match_the_benchmark_files():
    m = script("make_charts")
    stale = [p.name for p, svg in m.build().items() if not p.exists() or p.read_text() != svg]
    assert not stale, f"stale charts {stale}: run python scripts/make_charts.py"


def test_each_chart_is_a_plain_image_with_a_title():
    m = script("make_charts")
    files = m.build()
    assert {p.name for p in files} == {f"chart-{n}-{t}.svg" for n in ("harm", "finding", "numbers") for t in ("light", "dark")}
    for p, svg in files.items():
        assert "<script" not in svg and "onload" not in svg, p.name
        assert "<title>" in svg and 'role="img"' in svg, p.name


def test_the_harm_chart_shows_the_measured_values():
    m = script("make_charts")
    svg = m.build()[m.OUT / "chart-harm-light.svg"]
    sets = bench("stats.json")["main"]["sets"]
    for key in ("heldout", "external"):
        for arm in ("direct", "static_gate", "unread"):
            assert f">{sets[key]['arms'][arm]['harm']:g}<" in svg, (key, arm)
        assert f"p = {sets[key]['compare']['unread_vs_direct']['harm']['permutation_p']:g}" in svg


def test_the_finding_chart_shows_the_measured_rates():
    m = script("make_charts")
    svg = m.build()[m.OUT / "chart-finding-dark.svg"]
    r = bench("evasion.json")["rates"]
    for row in (r["passed_after_breaking_a_rule"], r["passed_first_time"]):
        assert f"{row['harmful_pct']}%  ({row['harmful']} of {row['plans']})" in svg


def test_the_numbers_chart_shows_the_measured_counts():
    m = script("make_charts")
    svg = m.build()[m.OUT / "chart-numbers-light.svg"]
    rt, vu = bench("redteam.json"), bench("vultr.json")
    assert f">{rt['contained']} / {rt['total']}<" in svg
    assert f">{vu['microvms']['total']:,}<" in svg
    assert f">{vu['postgres']['benchmark']['databases_created']:,}<" in svg


def test_light_and_dark_charts_carry_the_same_numbers():
    m = script("make_charts")
    files = m.build()
    numbers = lambda svg: re.findall(r">([^<]*\d[^<]*)<", svg)
    for name in ("harm", "finding", "numbers"):
        assert numbers(files[m.OUT / f"chart-{name}-light.svg"]) == numbers(files[m.OUT / f"chart-{name}-dark.svg"]), name


def test_every_local_link_in_the_readme_points_at_a_file():
    text = README.read_text()
    links = re.findall(r"\]\(([^)\s]+)\)", text) + re.findall(r'(?:src|srcset|href)="([^"]+)"', text)
    local = {l.split("#")[0] for l in links if not re.match(r"[a-z]+:", l) and not l.startswith("#")}
    missing = sorted(l for l in local if l and not (ROOT / l).exists())
    assert not missing, missing


def slug(heading: str) -> str:
    """GitHub's anchor for a heading."""
    return re.sub(r"[^\w\- ]", "", heading.strip().lower()).replace(" ", "-")


def test_every_anchor_in_the_readme_leads_to_a_heading():
    text = README.read_text()
    headings = {slug(h) for h in re.findall(r"^#{1,6} (.+)$", text, flags=re.M)}
    anchors = set(re.findall(r"\]\(#([^)]+)\)", text))
    assert not sorted(anchors - headings)


def section(text: str, heading: str) -> str:
    """Everything under a heading, up to the next one."""
    m = re.search(rf"^## {re.escape(heading)}[^\n]*\n\n(.+?)(?=^## |\Z)", text, flags=re.M | re.S)
    assert m, heading
    return m.group(1).strip()


def test_the_submission_texts_fit_the_form():
    text = (ROOT / "docs" / "SUBMISSION.md").read_text()
    short = section(text, "Short description")
    long = section(text, "Long description, for the form")
    assert 50 <= len(short) <= 255, len(short)
    assert 600 <= len(long) <= 2000, len(long)
    # the headings say how long each one is, so they must agree
    assert f"({len(short)} characters" in text


def test_the_market_file_has_what_the_readme_slides_and_film_read():
    m = json.loads((ROOT / "docs" / "market.json").read_text())
    for key in ("agents_market", "guardian_share", "developers_using_agents", "postgres_companies", "derived", "price", "revenue", "competition", "us", "next"):
        assert key in m, key
    assert m["us"]["usp"] and m["us"]["weakness"]
    for c in m["competition"]:
        assert c["who"] and c["strength"] and c["gap"]


def test_every_headline_claim_checks_out_from_the_raw_files():
    import subprocess
    import sys

    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "verify.py")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout


def test_the_unit_economics_add_up():
    m = script("make_readme_table")
    e = m.economics()
    assert e and abs(e["per_task"] - (e["inf"] + e["vx1_task"])) < 1e-12
    assert abs(e["per_k"] - 1000 * e["per_task"]) < 1e-9
    assert 0 < e["margin_1k"] < 1 and e["breakeven"] * e["per_task"] == pytest.approx(e["price"])
