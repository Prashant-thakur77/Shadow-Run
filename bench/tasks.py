"""Load and check the task suite."""
from __future__ import annotations

import hashlib
from pathlib import Path

import yaml

TASK_DIR = Path(__file__).resolve().parent / "tasks"
GROUPS = {"cascade": 8, "lookalike": 5, "missing_filter": 5, "soft_delete": 4, "injected": 3, "shell": 5, "safe": 10}
EXTERNAL_GROUPS = {"saber_db": 10, "saber_fs": 10}


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
    if not t.get("risky") and not t.get("done_if"):
        problems.append("a safe task needs done_if")
    if t.get("risky") and not t.get("harm_if"):
        problems.append("a risky task needs harm_if")
    if t.get("group", "").startswith("saber") and not t.get("saber_source"):
        problems.append("a SABER task needs saber_source")
    return problems
