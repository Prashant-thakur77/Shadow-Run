"""The plan is the unit everything binds to: frozen, split, hashed. Same bytes or no apply."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from sqlglot.errors import TokenError
from sqlglot.tokens import TokenType
from sqlglot.dialects.postgres import Postgres


class PlanError(ValueError):
    pass


def canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode()


def sha256_hex(obj: Any) -> str:
    return hashlib.sha256(canonical_json(obj)).hexdigest()


def split_sql(cmd: str) -> list[str]:
    """Split on top-level semicolons, keeping each statement's exact text.

    Uses the Postgres tokenizer, not a regex, so semicolons inside strings, comments and
    dollar-quoted bodies do not split. The exact text is kept because the approver reviewed it.
    """
    try:
        tokens = Postgres().tokenize(cmd)
    except TokenError as e:
        raise PlanError(f"could not tokenize SQL: {e}") from e
    out: list[str] = []
    start: int | None = None
    end = 0
    for tok in tokens:
        if tok.token_type == TokenType.SEMICOLON:
            if start is not None:
                out.append(cmd[start:end].strip())
            start = None
            continue
        if start is None:
            start = tok.start
        end = tok.end + 1
    if start is not None:
        out.append(cmd[start:end].strip())
    return [s for s in out if s]


def normalize_plan(raw_steps: list[dict]) -> list[dict]:
    """Validate and freeze step structure. Comment-only steps are dropped, not hashed."""
    if not isinstance(raw_steps, list) or not raw_steps:
        raise PlanError("a plan needs at least one step")
    steps: list[dict] = []
    for s in raw_steps:
        if not isinstance(s, dict) or not str(s.get("cmd", "")).strip():
            raise PlanError(f"step without a command: {s!r}")
        kind = s.get("type", "sql")
        if kind not in ("sql", "shell"):
            raise PlanError(f"unknown step type: {kind!r}")
        step = {"type": kind, "cmd": str(s["cmd"]).strip(), "why": str(s.get("why", ""))[:500]}
        if kind == "sql":
            step["statements"] = split_sql(step["cmd"])
            if not step["statements"]:
                continue
        steps.append(step)
    if not steps:
        raise PlanError("a plan needs at least one executable step")
    return steps


def plan_hash(target_id: str, steps: list[dict]) -> str:
    """SHA-256 of what will run. `why` is commentary and is excluded, so it cannot change the hash."""
    return sha256_hex({"target": target_id, "steps": [{"type": s["type"], "cmd": s["cmd"]} for s in steps]})


def guardrails_hash(guardrails: list[dict]) -> str:
    return sha256_hex([{"id": g["id"], "check": g.get("sql") or g.get("sh")} for g in guardrails])
