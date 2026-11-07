"""What code a benchmark run measured with. Standard library only, so the README generator can use it anywhere.

The one list of what counts as measuring code is MEASURING. bench.run hashes those files on the machine running it and stores
the result. The README generator hashes them again and prints either that they match or exactly which files differ, so no
sentence about the code staying the same is ever typed by hand.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# A path ending in / means every file under it. Anything that can change a score, a prompt, a plan's path to the database,
# or what the agent is shown belongs here.
MEASURING = (
    "bench/run.py",
    "bench/oracle.py",
    "bench/tasks.py",
    "bench/seeddb.py",
    "bench/provenance.py",
    "bench/tasks/",
    "bench/external_guardrails.yaml",
    "demo/guardrails.yaml",
    "demo/host_guardrails.yaml",
    "demo/schema.sql",
    "demo/seed.py",
    "demo/metrics.yaml",
    "demo/wider_list.yaml",
    "control/agent.py",
    "control/apply.py",
    "control/budget.py",
    "control/gate.py",
    "control/llm.py",
    "control/plan.py",
    "control/runner_client.py",
    "control/service.py",
    "control/settings.py",
    "control/snapshot.py",
    "checker/blast.py",
    "runner/",
)
SKIP_PARTS = {"__pycache__", ".pytest_cache"}
SKIP_SUFFIXES = {".pyc"}


def _files(root: Path) -> list[Path]:
    out: list[Path] = []
    for item in MEASURING:
        path = root / item
        if item.endswith("/"):
            out += [p for p in path.rglob("*") if p.is_file() and not (SKIP_PARTS & set(p.parts)) and p.suffix not in SKIP_SUFFIXES]
        elif path.is_file():
            out.append(path)
    return sorted(set(out))


def code_manifest(root: Path = ROOT) -> dict[str, str]:
    """{relative path: sha256 of its bytes}, for every measuring file that exists."""
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in _files(root)}


def code_sha256(manifest: dict[str, str]) -> str:
    h = hashlib.sha256()
    for path in sorted(manifest):
        h.update(f"{path}\0{manifest[path]}\n".encode())
    return h.hexdigest()


def compare(recorded: dict[str, str] | None, current: dict[str, str]) -> dict[str, list[str]]:
    """Which files differ from what a run recorded. All three lists empty means the same code."""
    recorded = recorded or {}
    return {
        "changed": sorted(p for p in recorded if p in current and recorded[p] != current[p]),
        "removed": sorted(p for p in recorded if p not in current),
        "added": sorted(p for p in current if p not in recorded),
    }


def code_line(doc: dict, current: dict[str, str] | None = None) -> str:
    """A true sentence about whether the code a results file measured is the code here now."""
    current = code_manifest() if current is None else current
    if not doc.get("code_files"):
        return "This run predates code hashes, so nothing can check it against the files here now."
    now = code_sha256(current)
    if doc.get("code_sha256") == now:
        return f"The files that measure match this run, sha256 `{now[:12]}`."
    diff = compare(doc["code_files"], current)
    parts = [f"{label}: {', '.join(f'`{p}`' for p in diff[key])}" for key, label in (("changed", "changed"), ("removed", "removed"), ("added", "new")) if diff[key]]
    return f"**The files that measure differ from this run.** {'; '.join(parts)}. Run sha256 `{str(doc.get('code_sha256'))[:12]}`, now `{now[:12]}`."
