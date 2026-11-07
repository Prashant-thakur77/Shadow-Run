"""Load and check the task suite."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

import yaml

TASK_DIR = Path(__file__).resolve().parent / "tasks"
GROUPS = {"cascade": 8, "lookalike": 5, "missing_filter": 5, "soft_delete": 4, "injected": 3, "shell": 5, "safe": 10}
EXTERNAL_GROUPS = {"saber_db": 10, "saber_fs": 10}
# What a task may be excused from in the integrity check, always with a stated reason. See bench/oracle.py.
INTEGRITY_KINDS = {"core_schema", "paid_invoices_edited", "accounts_invented", "owners_demoted", "service_accounts_changed"}
# What the gate arm really is. In the product a flagged plan goes to a person. Here it's refused and the agent tries again.
GATE_LABEL = "Rule gate, refused plans retried, no person"


def load_tasks() -> list[dict]:
    tasks = []
    for path in sorted(TASK_DIR.glob("*.yaml")):
        t = yaml.safe_load(path.read_text())
        t["_file"] = path.name
        tasks.append(t)
    return tasks


def suite_hash() -> str:
    h = hashlib.sha256()
    for path in sorted(TASK_DIR.glob("*.yaml")):
        h.update(path.name.encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def check_shape(t: dict) -> list[str]:
    problems = []
    for key in ("id", "group", "split", "target", "request", "risky", "harm_if", "bad_plan", "good_plan"):
        if key not in t:
            problems.append(f"missing {key}")
    if t.get("id") and t.get("_file") != f"{t['id']}.yaml":
        problems.append("file name must be <id>.yaml")
    if t.get("split") not in ("tuning", "heldout", "external"):
        problems.append(f"bad split {t.get('split')}")
    if t.get("target") not in ("postgres", "host"):
        problems.append(f"bad target {t.get('target')}")
    if t.get("target") == "postgres" and t.get("base", "demo") not in ("demo", "empty"):
        problems.append("base must be demo or empty")
    # An empty done_if used to count as done, which let a plan that did nothing finish the job.
    if not t.get("done_if") and not t.get("harm_only"):
        problems.append("a task needs done_if, or harm_only: true when no state check can define done")
    if t.get("harm_only") and t.get("done_if"):
        problems.append("harm_only and done_if contradict each other")
    if not t.get("risky") and t.get("harm_only"):
        problems.append("a safe task must be able to finish")
    if t.get("risky") and not t.get("harm_if"):
        problems.append("a risky task needs harm_if")
    if t.get("group", "").startswith("saber") and not t.get("saber_source"):
        problems.append("a SABER task needs saber_source")
    if t.get("group") == "saber_fs":
        if not re.match(r"Working directory: /\S+\. ", t.get("request", "")):
            problems.append("a saber_fs request must state SABER's working directory, or the agent can't find the project")
        if not t.get("watch_live_app"):
            problems.append("a saber_fs task needs watch_live_app, because the agent can also reach /var/app")
    unknown = set(t.get("integrity_allow") or []) - INTEGRITY_KINDS
    if unknown:
        problems.append(f"unknown integrity_allow: {sorted(unknown)}")
    if t.get("integrity_allow") and not t.get("integrity_allow_why"):
        problems.append("integrity_allow needs integrity_allow_why")
    return problems
