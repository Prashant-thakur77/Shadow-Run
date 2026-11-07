#!/usr/bin/env python3
"""How much of Shadow Run runs on Vultr, measured. Writes bench/vultr.json.

Every figure is computed here, from files in this repo or from Vultr's own APIs at run time, and each section says where its
figures came from. Nothing is created, changed or deleted: GET requests to api.vultr.com/v2 and the inference catalogue, and one
S3 listing of the evidence bucket. Keys come from the environment (.env) and are never written or printed. If one source fails,
its section records the error and the rest still runs.

    python -m bench.vultr_usage
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

import httpx

from bench import provenance
from control import llm, settings

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
OUT = BENCH / "vultr.json"
API = "https://api.vultr.com/v2"
TAG = "shadowrun"

# Which model each phase's calls go to, as control/agent.py, control/evasion.py and control/llm.py call them. "planner" means
# the run's own planner model (bench/run.py passes --model to the planner and to nothing else).
PHASE_SETTING = {
    "planner": "planner",
    "explainer": "EXPLAINER_MODEL",
    "second_opinion": "SECOND_OPINION_MODEL",
    "guardrail_drafter": "GUARDRAIL_MODEL",
    "content_safety": "SAFETY_MODEL",
}

# What each configured model does, read from control/settings.py at run time. The words are ours; the model names are not.
JOBS = (
    ("PLANNER_MODEL", "planner", "writes the plan, and rewrites it after each failed rehearsal", "control/agent.py call_planner"),
    ("EXPLAINER_MODEL", "explainer", "two or three sentences on the measured report; a number that isn't in the measurements is flagged", "control/agent.py explain"),
    ("GUARDRAIL_MODEL", "guardrail drafter", "proposes business guardrails from the schema, for a person to accept", "control/agent.py draft_guardrails"),
    ("SECOND_OPINION_MODEL", "second opinion", "reads the request against the final plan; its doubt can add a person, never remove one", "control/agent.py second_opinion"),
    ("SECOND_OPINION_MODEL", "evasion reader", "reads a plan that passed after breaking a rule, and says if it got around the rule", "control/evasion.py second_reader"),
    ("SAFETY_MODEL", "content safety", "checks text people store, advisory only", "control/llm.py safety_verdict"),
)

# What the evidence bucket's top-level prefixes hold, from control/evidence.py.
PREFIX_WHAT = {
    "runs": "signed evidence bundle per run (control/evidence.py write_bundle)",
    "backups": "pg_dump of prod taken before each apply (control/evidence.py backup_prod)",
}

# Logical database name prefixes on the Postgres cluster, from bench/seeddb.py and bench/scale.py.
DB_PREFIX_WHAT = {
    "b": "one benchmark run's own copy (bench/seeddb.py new_db_from_template)",
    "bt": "a benchmark task's template (bench/seeddb.py make_template)",
    "bs": "the scale test's database (bench/scale.py)",
}

# Rehearsal verdicts that mean control/agent.py's run_loop reached the measured report, so the explainer was called.
EXPLAINED = ("passed", "failed_guardrails", "evaded_rule", "read_only_plan")
CAPTURE_GAP = "the row log missed changes"
CHANGE_KEYS = ("rows_changed", "ddl_commands", "files_created", "files_deleted", "files_changed", "services_stopped")
IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")


# --------------------------------------------------------------------------- helpers


def rel(p: Path) -> str:
    try:
        return p.relative_to(ROOT).as_posix()
    except ValueError:
        return str(p)


def pct(values: list[float], q: float) -> float | None:
    """The same rule as bench/run.py's pct, so these match the results files."""
    if not values:
        return None
    s = sorted(values)
    return round(s[min(len(s) - 1, int(round(q * (len(s) - 1))))], 1)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def secret_values() -> list[str]:
    names = [k for k in os.environ if re.search(r"KEY|SECRET|PASSWORD|TOKEN", k)]
    return sorted({os.environ[k] for k in names if len(os.environ.get(k, "")) >= 8}, key=len, reverse=True)


def scrub(text: str) -> str:
    for v in secret_values():
        text = text.replace(v, "[redacted]")
    return text


def section(errors: dict, name: str, fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception as e:  # one failed source must not stop the others
        errors[name] = scrub(f"{type(e).__name__}: {str(e)[:300]}")
        return None


class VultrGet:
    """GET only. There is no other method on this class, on purpose."""

    def __init__(self, key: str) -> None:
        self.http = httpx.Client(base_url=API, headers={"Authorization": f"Bearer {key}"}, timeout=30)

    def get(self, path: str, params: dict | None = None) -> dict:
        for attempt in range(4):
            r = self.http.get(path, params=params)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(1.5 * (attempt + 1))
                continue
            if r.status_code != 200:
                raise RuntimeError(f"GET {path} -> HTTP {r.status_code}")
            return r.json()
        raise RuntimeError(f"GET {path} -> gave up after retries")

    def list(self, path: str, key: str) -> list[dict]:
        out: list[dict] = []
        cursor = ""
        while True:
            d = self.get(path, {"per_page": 500, **({"cursor": cursor} if cursor else {})})
            out += d.get(key, [])
            cursor = (d.get("meta", {}).get("links") or {}).get("next", "")
            if not cursor:
                return out


def ours(item: dict) -> bool:
    tags = item.get("tags") or []
    names = [item.get("label"), item.get("description"), item.get("tag")]
    return TAG in tags or any(isinstance(n, str) and n.startswith(TAG) for n in names)


# --------------------------------------------------------------------------- the benchmark's files


def benchmark_files(bench: Path = BENCH) -> dict:
    """bench/results.json is the final benchmark. Every other results file of the same code counts with it; the rest don't."""
    main = json.loads((bench / "results.json").read_text())
    sha = main["code_sha256"]
    used, skipped = [], []
    for res in sorted(bench.glob("results*.json")):
        suffix = res.name[len("results"):-len(".json")]
        runs = bench / f"runs{suffix}.jsonl"
        doc = json.loads(res.read_text())
        entry = {
            "results": rel(res), "runs": rel(runs), "label": doc.get("label") or (suffix.lstrip(".") or "main"), "planner_model": doc.get("model"),
            "at": doc.get("at"), "status": doc.get("status"), "runs_in_results": doc.get("runs"), "code_sha256": (doc.get("code_sha256") or "")[:12] or None,
        }
        if doc.get("code_sha256") != sha:
            skipped.append({**entry, "why": "measured with different code"})
        elif not runs.exists():
            skipped.append({**entry, "why": "no runs file"})
        else:
            used.append(entry)
    now = provenance.code_sha256(provenance.code_manifest())
    return {"code_sha256": sha, "code_matches_checkout": now == sha, "files": used, "skipped": skipped}


def load_runs(files: list[dict], root: Path = ROOT) -> list[tuple[dict, dict]]:
    """Every line of every runs file, superseded harness errors included: they made real calls too."""
    return [(f, r) for f in files for r in read_jsonl(root / f["runs"])]


def phase_model(phase: str, run_model: str) -> str:
    base = phase[: -len("_repair")] if phase.endswith("_repair") else phase
    setting = PHASE_SETTING.get(base)
    if setting is None:
        return "unknown"
    return run_model if setting == "planner" else getattr(settings, setting)


def inference(pairs: list[tuple[dict, dict]], prices: dict[str, tuple[float, float]] | None) -> dict:
    runs = [r for _, r in pairs]
    by_phase: dict[str, dict] = defaultdict(lambda: {"cost_usd": 0.0, "runs": 0, "models": set()})
    by_model: dict[str, dict] = defaultdict(lambda: {"cost_usd": 0.0, "phases": set()})
    by_planner: dict[str, dict] = defaultdict(lambda: {"runs": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0})
    by_file: dict[str, dict] = defaultdict(lambda: {"runs": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0})
    checked, diffs = 0, []
    for f, r in pairs:
        model = r.get("model") or f["planner_model"]
        for phase, cost in (r.get("usage_by_phase") or {}).items():
            m = phase_model(phase, model)
            by_phase[phase]["cost_usd"] += cost
            by_phase[phase]["runs"] += 1
            by_phase[phase]["models"].add(m)
            by_model[m]["cost_usd"] += cost
            by_model[m]["phases"].add(phase)
        for agg in (by_planner[model], by_file[f["runs"]]):
            agg["runs"] += 1
            agg["prompt_tokens"] += r.get("prompt_tokens", 0)
            agg["completion_tokens"] += r.get("completion_tokens", 0)
            agg["cost_usd"] += r.get("cost_usd", 0.0)
        # Where every call in a run went to one model, today's catalogue prices must reproduce the run's own cost.
        models = {phase_model(p, model) for p in (r.get("usage_by_phase") or {})}
        if prices and len(models) == 1 and next(iter(models)) in prices and r.get("prompt_tokens"):
            p_in, p_out = prices[next(iter(models))]
            checked += 1
            diffs.append(abs(r["prompt_tokens"] * p_in + r["completion_tokens"] * p_out - r.get("cost_usd", 0.0)))
    shadow = [r for r in runs if r.get("mode") == "shadow_run"]
    verdicts = [v for r in shadow for v in (r.get("verdicts") or [])]
    total_pt = sum(r.get("prompt_tokens", 0) for r in runs)
    total_ct = sum(r.get("completion_tokens", 0) for r in runs)
    r6 = lambda x: round(x, 6)
    return {
        "source": "bench/runs*.jsonl: per-run usage that bench/run.py sums from control/llm.py's record of each call, priced at the time from the inference catalogue",
        "base_url": settings.INFERENCE_BASE,
        "base_is_vultr": llm.is_vultr_base(settings.INFERENCE_BASE),
        "runs": len(runs),
        "harness_error_lines": sum(1 for r in runs if r.get("outcome") == "harness_error"),
        "models_used": len(by_model),
        "prompt_tokens": total_pt,
        "completion_tokens": total_ct,
        "tokens": total_pt + total_ct,
        "cost_usd": r6(sum(r.get("cost_usd", 0.0) for r in runs)),
        "by_phase": sorted(({"phase": p, "models": sorted(v["models"]), "cost_usd": r6(v["cost_usd"]), "runs_with_calls": v["runs"]} for p, v in by_phase.items()), key=lambda x: -x["cost_usd"]),
        "by_model": sorted(({"model": m, "cost_usd": r6(v["cost_usd"]), "phases": sorted(v["phases"])} for m, v in by_model.items()), key=lambda x: -x["cost_usd"]),
        "by_run_planner": sorted(({"planner_model": m, **{k: r6(v) if k == "cost_usd" else v for k, v in agg.items()}, "tokens": agg["prompt_tokens"] + agg["completion_tokens"]} for m, agg in by_planner.items()), key=lambda x: -x["runs"]),
        "by_file": [{"runs_file": k, **{kk: r6(vv) if kk == "cost_usd" else vv for kk, vv in v.items()}} for k, v in by_file.items()],
        "calls_at_least": {
            "planner": sum(len(r.get("attempts") or []) or (r.get("tries") or 0) for r in runs),
            "explainer": sum(1 for v in verdicts if v in EXPLAINED),
            "evasion_reader": sum(len(r.get("evasions") or []) for r in runs),
            "how": "bench/run.py keeps tokens per run and cost per phase, not each call. Each recorded attempt asked the planner at least once; each rehearsed shadow_run attempt that reached a report was explained once; each recorded evasion check asked the second reader once. Reads, JSON repairs and retries on an empty reply add calls these counts leave out.",
        },
        "price_check": {
            "runs_checked": checked,
            "max_abs_diff_usd": r6(max(diffs)) if diffs else None,
            "how": "runs whose calls all went to one model, repriced with today's catalogue and compared with the cost the run recorded",
        },
        "not_recorded": "Tokens per model inside a run, and each call. Tokens are kept per run, so they are grouped by the run's planner model, which includes that run's explainer and second-reader tokens.",
    }


def reproductions_in(r: dict) -> int:
    """control/agent.py runs a second microVM when an attempt passes every guardrail and changed something. The runs files keep
    verdicts, the final report's totals and attempt errors, so that is counted from them: an evaded_rule attempt always got
    there, a final passed attempt did if its totals show a change, and so did a measurement-gap error with no failed guardrail."""
    n = 0
    attempts = r.get("attempts") or []
    for i, a in enumerate(attempts):
        v = a.get("verdict")
        if v == "evaded_rule":
            n += 1
        elif v == "passed" and i == len(attempts) - 1 and any((r.get("report_totals") or {}).get(k) for k in CHANGE_KEYS):
            n += 1
        elif v == "sandbox_error" and str(a.get("error", "")).startswith(CAPTURE_GAP) and not a.get("failed_guardrails"):
            n += 1
    return n


def microvms(pairs: list[tuple[dict, dict]], bench: Path = BENCH) -> dict:
    shadow = [(f, r) for f, r in pairs if r.get("mode") == "shadow_run"]
    rehearse = [v for _, r in shadow for v in (r.get("rehearsal_ms") or []) if v]
    boots = [v for _, r in shadow for v in (r.get("clone_boot_ms") or []) if v]
    contained = [c for _, r in shadow for c in (r.get("contained") or [])]
    first = sum(len(r.get("rehearsal_ms") or []) for _, r in shadow)
    again = sum(reproductions_in(r) for _, r in shadow)
    per_file: dict[str, dict] = defaultdict(lambda: {"rehearsals": 0, "reproductions": 0})
    for f, r in shadow:
        per_file[f["runs"]]["rehearsals"] += len(r.get("rehearsal_ms") or [])
        per_file[f["runs"]]["reproductions"] += reproductions_in(r)
    out: dict[str, Any] = {
        "source": "bench/runs*.jsonl, shadow_run mode: one entry per rehearsed attempt in rehearsal_ms, clone_boot_ms and contained",
        "rehearsals": first,
        "reproductions": again,
        "total": first + again,
        "containment_complete": sum(1 for c in contained if c),
        "containment_incomplete": sum(1 for c in contained if not c),
        "clone_boot_ms": {"p50": pct(boots, 0.5), "p95": pct(boots, 0.95), "n": len(boots)},
        "rehearsal_s": {"p50": round(pct(rehearse, 0.5) / 1000, 2) if rehearse else None, "p95": round(pct(rehearse, 0.95) / 1000, 2) if rehearse else None, "n": len(rehearse)},
        "by_file": [{"runs_file": k, **v} for k, v in per_file.items()],
        "how_reproductions": "control/agent.py runs a second microVM when an attempt passes every guardrail and changed something. The runs files don't keep that second run, so it is counted from what they keep: every evaded_rule attempt, a final passed attempt whose totals show a change, and a measurement-gap error with no failed guardrail.",
        "not_counted": "The agent's read queries and each task's schema inspection also run in one-shot microVMs. The benchmark doesn't record them, so they aren't in these counts.",
    }
    soak = bench / "soak.json"
    if soak.exists():
        s = json.loads(soak.read_text())
        out["soak"] = {k: s.get(k) for k in ("at", "rehearsals", "all_contained", "all_teardown_ok", "rehearsal_ms_p50", "clone_boot_ms_p50", "wall_s", "prod_unchanged", "rerun")} | {"source": "bench/soak.json"}
    red = bench / "redteam.json"
    if red.exists():
        d = json.loads(red.read_text())
        out["redteam"] = {"source": "bench/redteam.json", "attacks": d.get("total"), "contained": d.get("contained"), "prod_unchanged": d.get("prod_unchanged"), "golden_unchanged": d.get("golden_unchanged"), "at": d.get("created_at")}
    sc = bench / "scale.json"
    if sc.exists():
        d = json.loads(sc.read_text())
        ok = [row for row in d.get("rows", []) if row.get("rehearsals_ok")]
        if ok:
            big = max(ok, key=lambda row: row.get("db_mb") or 0)
            out["scale"] = {"source": "bench/scale.json", "at": d.get("at"), "largest_db_mb_rehearsed": big.get("db_mb"), "its_rows_changed": big.get("rows_changed"), "its_rehearsal_s": big.get("rehearsal_total_s"), "its_clone_boot_ms": big.get("clone_boot_ms")}
    return out


def benchmark_databases(pairs: list[tuple[dict, dict]]) -> dict:
    """bench/run.py gives every SQL run its own database, copied from the task's template, and drops it when the run ends."""
    sql = [(f, r) for f, r in pairs if r.get("target") == "postgres"]
    finished = [(f, r) for f, r in sql if r.get("outcome") != "harness_error"]
    per_file: dict[str, dict] = defaultdict(lambda: {"databases": 0, "drop_failed": 0, "tasks": set()})
    for f, r in finished:
        per_file[f["runs"]]["databases"] += 1
        per_file[f["runs"]]["drop_failed"] += 1 if r.get("cleanup_error") else 0
        per_file[f["runs"]]["tasks"].add(r.get("task"))
    return {
        "source": "bench/runs*.jsonl, target postgres: one CREATE DATABASE ... TEMPLATE per run and a DROP DATABASE in finally (bench/run.py run_sql_task, bench/seeddb.py)",
        "databases_created": len(finished),
        "dropped": sum(1 for _, r in finished if not r.get("cleanup_error")),
        "drop_failed": sum(1 for _, r in finished if r.get("cleanup_error")),
        "harness_errors_not_counted": len(sql) - len(finished),
        "templates_at_least": sum(len(v["tasks"]) for v in per_file.values()),
        "by_file": [{"runs_file": k, "databases": v["databases"], "drop_failed": v["drop_failed"], "templates_at_least": len(v["tasks"])} for k, v in per_file.items()],
        "how_templates": "one template per SQL task per benchmark invocation; a resumed batch builds them again, so this is a floor",
    }


# --------------------------------------------------------------------------- Vultr's APIs


def catalogue() -> tuple[dict, dict[str, tuple[float, float]]]:
    base = settings.INFERENCE_BASE.rstrip("/")
    data = httpx.get(f"{base}/models", timeout=30).json()["data"]
    prices: dict[str, tuple[float, float]] = {}
    info: dict[str, dict] = {}
    for m in data:
        p: dict[str, float] = {}
        ctx = None
        for io in m.get("input_modalities", []) + m.get("output_modalities", []):
            for x in io.get("pricing", []):
                if x.get("unit") == "token":
                    p[x["type"]] = float(x["cost_usd"])
            ctx = ctx or ((io.get("supported_inputs") or {}).get("max_context_length") or {}).get("value")
        prices[m["id"]] = (p.get("prompt", 0.0), p.get("completion", 0.0))
        info[m["id"]] = {"name": m.get("name"), "prompt": p.get("prompt"), "completion": p.get("completion"), "context_tokens": ctx}
    return {"source": f"GET {base}/models (no key)", "models_listed": len(data), "info": info}, prices


def models(bench_info: dict | None, cat: dict | None) -> list[dict]:
    from control import hardening

    jobs: dict[str, list[dict]] = defaultdict(list)
    for setting, job, what, where in JOBS:
        jobs[getattr(settings, setting)].append({"job": job, "what": what, "setting": setting, "where": where})
    jobs[hardening.ATTACK_MODEL].append({"job": "gauntlet attacker", "what": "writes real attacks on the guardrails, then the rules that would have stopped them", "setting": "ATTACK_MODEL", "where": "control/hardening.py"})
    for f in (bench_info or {}).get("files", []):
        m = f["planner_model"]
        if m and m != settings.PLANNER_MODEL and not any(j["job"] == "benchmark planner" for j in jobs[m]):
            jobs[m].append({"job": "benchmark planner", "what": "the planner in a robustness run of the same benchmark", "setting": "--model", "where": f["results"]})
    info = (cat or {}).get("info", {})
    out = []
    for m, js in jobs.items():
        i = info.get(m)
        per_m = lambda v: round(v * 1_000_000, 4) if isinstance(v, float) else None
        out.append({
            "model": m, "jobs": js, "listed": i is not None,
            "usd_per_million_prompt": per_m(i.get("prompt")) if i else None, "usd_per_million_completion": per_m(i.get("completion")) if i else None,
            "context_tokens": i.get("context_tokens") if i else None, "name": i.get("name") if i else None,
        })
    return out


def resources(v: VultrGet, errors: dict) -> dict:
    out: dict[str, Any] = {"source": "GET /v2/instances, /v2/plans, /v2/databases, /v2/object-storage, /v2/vpcs, /v2/firewalls, filtered to resources tagged or labelled shadowrun"}

    def instances() -> list[dict]:
        plans = {p["id"]: p for p in v.list("/plans", "plans")}
        keep = ("label", "plan", "region", "status", "power_status", "server_status", "vcpu_count", "ram", "disk", "os", "date_created", "tags")
        return [{**{k: i.get(k) for k in keep}, "usd_per_hour": plans.get(i["plan"], {}).get("hourly_cost"), "usd_per_month": plans.get(i["plan"], {}).get("monthly_cost"), "in_vpc": bool(i.get("vpcs") or i.get("internal_ip"))} for i in v.list("/instances", "instances") if ours(i)]

    def databases() -> list[dict]:
        keep = ("label", "database_engine", "database_engine_version", "plan", "region", "status", "plan_vcpus", "plan_ram", "plan_disk", "plan_replicas", "plan_price", "date_created", "latest_backup")
        return [{**{k: d.get(k) for k in keep}, "in_vpc": bool(d.get("vpc_id"))} for d in v.list("/databases", "databases") if ours(d)]

    def storage() -> list[dict]:
        keep = ("label", "region", "location", "status", "s3_hostname", "date_created")
        return [{**{k: o.get(k) for k in keep}, "tier": (o.get("tier") or {}).get("sales_name"), "usd_per_month": (o.get("tier") or {}).get("price")} for o in v.list("/object-storage", "object_storages") if ours(o)]

    def vpcs() -> list[dict]:
        try:
            items = v.list("/vpcs", "vpcs")
        except RuntimeError:
            items = v.list("/vpc2", "vpcs")
        return [{k: n.get(k) for k in ("description", "region", "v4_subnet", "v4_subnet_mask", "date_created")} for n in items if ours(n)]

    def firewalls() -> list[dict]:
        groups = [g for g in v.list("/firewalls", "firewall_groups") if ours(g)]
        # Rule counts only: the rules name the admin's own address.
        return [{"description": g.get("description"), "date_created": g.get("date_created"), "rules": len(v.list(f"/firewalls/{g['id']}/rules", "firewall_rules"))} for g in groups]

    for name, fn in (("instances", instances), ("databases", databases), ("object_storage", storage), ("vpcs", vpcs), ("firewalls", firewalls)):
        out[name] = section(errors, f"resources.{name}", fn)
    out["count"] = sum(len(out[k] or []) for k in ("instances", "databases", "object_storage", "vpcs", "firewalls"))
    out["firewall_rules"] = sum(f["rules"] for f in out["firewalls"] or [])
    return out


def cluster(v: VultrGet) -> dict:
    db = next((d for d in v.list("/databases", "databases") if ours(d)), None)
    if db is None:
        raise RuntimeError("no Managed PostgreSQL tagged shadowrun")
    names = [d["name"] for d in v.list(f"/databases/{db['id']}/dbs", "dbs")]
    prefixes = Counter(n.split("_")[0] if "_" in n else n for n in names)
    usage = v.get(f"/databases/{db['id']}/usage").get("usage", {})
    return {
        "source": "GET /v2/databases, /v2/databases/{id}/dbs, /v2/databases/{id}/usage",
        "label": db.get("label"), "engine": db.get("database_engine"), "version": db.get("database_engine_version"), "plan": db.get("plan"),
        "region": db.get("region"), "status": db.get("status"), "vcpus": db.get("plan_vcpus"), "ram_mb": db.get("plan_ram"), "disk_gb": db.get("plan_disk"),
        "replicas": db.get("plan_replicas"), "usd_per_month": db.get("plan_price"), "in_vpc": bool(db.get("vpc_id")), "latest_backup": db.get("latest_backup"),
        "logical_databases": len(names),
        "by_prefix": [{"prefix": p, "count": c, "what": DB_PREFIX_WHAT.get(p)} for p, c in prefixes.most_common()],
        "usage": usage,
        "note": "Logical databases listed now. Benchmark copies and templates still here are ones a stopped or resumed run didn't drop.",
    }


def object_storage() -> dict:
    import boto3
    from botocore.config import Config

    if not (settings.S3_ENDPOINT and settings.S3_ACCESS_KEY and settings.S3_SECRET_KEY and settings.S3_BUCKET):
        raise RuntimeError("SHADOWRUN_S3_* is not set in the environment")
    s3 = boto3.client("s3", endpoint_url=settings.S3_ENDPOINT, aws_access_key_id=settings.S3_ACCESS_KEY, aws_secret_access_key=settings.S3_SECRET_KEY, config=Config(signature_version="s3v4", retries={"max_attempts": 4}))
    agg: dict[str, dict] = defaultdict(lambda: {"objects": 0, "bytes": 0})
    first = last = None
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=settings.S3_BUCKET):
        for it in page.get("Contents", []):
            prefix = it["Key"].split("/", 1)[0] if "/" in it["Key"] else "(top level)"
            agg[prefix]["objects"] += 1
            agg[prefix]["bytes"] += it["Size"]
            t = it["LastModified"]
            first = t if first is None or t < first else first
            last = t if last is None or t > last else last
    iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None
    return {
        "source": f"S3 ListObjectsV2 on {settings.S3_BUCKET} at {settings.S3_ENDPOINT.split('//')[-1]}",
        "bucket": settings.S3_BUCKET,
        "objects": sum(a["objects"] for a in agg.values()),
        "bytes": sum(a["bytes"] for a in agg.values()),
        "by_prefix": sorted(({"prefix": p, **a, "what": PREFIX_WHAT.get(p)} for p, a in agg.items()), key=lambda x: -x["objects"]),
        "first_written": iso(first),
        "last_written": iso(last),
    }


def spend(v: VultrGet, errors: dict) -> dict:
    out: dict[str, Any] = {}

    def budget() -> dict:
        # infra/budget.py is read-only from end to end. It prints one JSON object.
        env = {**os.environ, "TMPDIR": os.environ.get("TMPDIR", str(ROOT / "var" / "tmp"))}
        r = subprocess.run([sys.executable, str(ROOT / "infra" / "budget.py")], capture_output=True, text=True, timeout=120, env=env)
        if r.returncode != 0:
            raise RuntimeError(f"infra/budget.py exited {r.returncode}: {scrub(r.stderr.strip()[-200:])}")
        doc = json.loads(r.stdout)
        doc["source"] = "infra/budget.py (GET /v2/account, /v2/plans, /v2/instances, /v2/databases, /v2/object-storage, /v2/inference)"
        doc["how"] = "spent = ceiling - credit left, where credit left = -(balance + pending charges)"
        return doc

    def billed() -> dict:
        items = v.list("/billing/pending-charges", "pending_charges")
        by: dict[str, dict] = defaultdict(lambda: {"usd": 0.0, "lines": 0})
        lines = []
        for it in items:
            label = re.search(r"\[([^\]]+)\]|\(([^)]*shadowrun[^)]*)\)", it.get("description", ""))
            p = it.get("product") or "other"
            by[p]["usd"] += float(it.get("total") or 0)
            by[p]["lines"] += 1
            lines.append({"product": p, "resource": (label.group(1) or label.group(2)) if label else IPV4.sub("", it.get("description", "")).strip(), "usd": it.get("total"), "units": it.get("units"), "unit_type": it.get("unit_type"), "start": it.get("start_date"), "end": it.get("end_date")})
        history = [{k: h.get(k) for k in ("description", "amount", "type", "date")} for h in v.list("/billing/history", "billing_history")]
        return {
            "source": "GET /v2/billing/pending-charges and /v2/billing/history",
            "total_usd": round(sum(b["usd"] for b in by.values()), 2),
            "by_product": sorted(({"product": p, "usd": round(b["usd"], 2), "lines": b["lines"]} for p, b in by.items()), key=lambda x: -x["usd"]),
            "lines": lines,
            "history": history,
            "note": "Everything Vultr has billed on this account so far this month, at Vultr's own rounding. Inference here is every call made, during building, testing and the benchmark, not only the final benchmark.",
        }

    out["budget"] = section(errors, "spend.budget", budget)
    out["billed"] = section(errors, "spend.billed", billed)
    return out


# --------------------------------------------------------------------------- putting it together


def build() -> dict:
    errors: dict[str, str] = {}
    doc: dict[str, Any] = {
        "schema": "shadowrun.vultr/1",
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "rerun": "python -m bench.vultr_usage",
        "read_only": "GET requests to api.vultr.com/v2 and the inference catalogue, and one S3 listing. Nothing created, changed or deleted.",
    }
    bench_info = section(errors, "benchmark", benchmark_files)
    doc["benchmark"] = bench_info
    pairs = section(errors, "benchmark.runs", lambda: load_runs(bench_info["files"])) if bench_info else None
    cat_and_prices = section(errors, "catalogue", catalogue)
    cat, prices = cat_and_prices if cat_and_prices else (None, None)
    if pairs is not None:
        doc["inference"] = section(errors, "inference", lambda: inference(pairs, prices))
        doc["microvms"] = section(errors, "microvms", lambda: microvms(pairs))
    doc["models"] = section(errors, "models", lambda: models(bench_info, cat))
    doc["catalogue"] = {k: v for k, v in cat.items() if k != "info"} if cat else None

    postgres: dict[str, Any] = {}
    if pairs is not None:
        postgres["benchmark"] = section(errors, "postgres.benchmark", lambda: benchmark_databases(pairs))
    key = os.environ.get("VULTR_API_KEY", "")
    v = VultrGet(key) if key else None
    if v is None:
        errors["vultr_api"] = "VULTR_API_KEY is not set in the environment"
        recorded = _state().get("postgres") or {}
        postgres["cluster"] = {**{k: recorded.get(k) for k in ("plan", "region", "status", "version")}, "source": "infra/STATE.json"} if recorded else None
    else:
        postgres["cluster"] = section(errors, "postgres.cluster", lambda: cluster(v))
    doc["postgres"] = postgres
    doc["object_storage"] = section(errors, "object_storage", object_storage)
    doc["resources"] = resources(v, errors) if v else None
    doc["spend"] = spend(v, errors) if v else None
    doc["errors"] = errors
    return doc


def _state() -> dict:
    p = ROOT / "infra" / "STATE.json"
    return json.loads(p.read_text()) if p.exists() else {}


def main() -> None:
    os.environ.setdefault("TMPDIR", str(ROOT / "var" / "tmp"))
    doc = build()
    text = json.dumps(doc, indent=1, default=str) + "\n"
    leaked = [s for s in secret_values() if s in text]
    if leaked:
        raise SystemExit("refusing to write bench/vultr.json: it would contain a secret from the environment")
    OUT.write_text(text)
    inf, vm, pg, os_ = doc.get("inference") or {}, doc.get("microvms") or {}, (doc.get("postgres") or {}).get("benchmark") or {}, doc.get("object_storage") or {}
    print(f"wrote {rel(OUT)}: {inf.get('tokens')} tokens, ${inf.get('cost_usd')} over {inf.get('runs')} runs; {vm.get('total')} microVM rehearsals; "
          f"{pg.get('databases_created')} benchmark databases; {os_.get('objects')} objects in Object Storage; errors: {sorted(doc['errors']) or 'none'}")


if __name__ == "__main__":
    main()
