"""Most negative controls try to get past a check. These confirm the honest path still works, which is a different claim."""
from __future__ import annotations

HONEST_PATH = (
    "Correct approval by a different person",
    "Apply the approved plan",
    "Prod really changed after apply",
    "Evidence bundle written to Object Storage",
    "Pre-apply backup written to Object Storage",
    "A small change to a column on the list",
    "A plan comes with an undo",
    "A second clone reproduces the result",
    "Apply a change, then undo it",
    "A reviewer's rejection becomes a guardrail",
    "Audit log hash chain verifies",
)


def control_kind(name: str) -> str:
    return "honest path" if name.startswith(HONEST_PATH) else "attack"
