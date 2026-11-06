"""How big a plan may be. Parsing is the expensive part, and it happens before anything else can refuse."""
from __future__ import annotations

from typing import Any

MAX_STEPS = 50
MAX_STEP_BYTES = 100_000
MAX_PLAN_BYTES = 256_000
MAX_BODY_BYTES = 1_000_000


def plan_too_big(steps: Any) -> str | None:
    """What's wrong with this plan's size, or None. A plan that isn't a list of steps is left for the plan's own check."""
    if not isinstance(steps, list):
        return None
    if len(steps) > MAX_STEPS:
        return f"a plan can have at most {MAX_STEPS} steps; this one has {len(steps)}"
    sizes = [len(str(s.get("cmd", "")).encode("utf-8", "replace")) for s in steps if isinstance(s, dict)]
    if any(size > MAX_STEP_BYTES for size in sizes):
        return f"a step can be at most {MAX_STEP_BYTES:,} bytes"
    if sum(sizes) > MAX_PLAN_BYTES:
        return f"a plan can be at most {MAX_PLAN_BYTES:,} bytes"
    return None
