"""Blast-radius budget per target: small safe changes go through without waiting for a person."""
from __future__ import annotations

DEFAULT_BUDGET = {"max_rows_changed": 100, "max_table_pct": 10.0, "max_cascade_rows": 0, "allow_drop": False, "allow_truncate": False, "allow_ddl": True}


DEFAULT_HOST_BUDGET = {"max_files_deleted": 20, "max_files_changed": 5, "max_services_stopped": 0}


IRREVERSIBLE_REASON = "the plan contains an irreversible write (DELETE, DROP, TRUNCATE, rm), which always needs a person"


def check_host_budget(report: dict, gate: dict, guardrails: list[dict], budget: dict | None = None) -> dict:
    b = {**DEFAULT_HOST_BUDGET, **(budget or {})}
    reasons: list[str] = []
    totals = report.get("totals", {})
    if not totals:
        reasons.append("no measurements from the rehearsal")
    # Measured as well as classified: a wrapper such as `bash -c` can hide rm from the gate, not from this.
    if gate.get("highest_risk") == "irreversible_write" or totals.get("files_deleted", 0) > 0:
        reasons.append(IRREVERSIBLE_REASON)
    if totals.get("files_deleted", 0) > b["max_files_deleted"]:
        reasons.append(f"{totals['files_deleted']} files deleted; budget is {b['max_files_deleted']}")
    if totals.get("files_changed", 0) > b["max_files_changed"]:
        reasons.append(f"{totals['files_changed']} files changed; budget is {b['max_files_changed']}")
    if totals.get("services_stopped", 0) > b["max_services_stopped"]:
        reasons.append(f"{totals['services_stopped']} service(s) stopped; budget is {b['max_services_stopped']}")
    if gate.get("verdict") != "pass":
        reasons.append(f"static gate verdict is {gate.get('verdict')}")
    if any(not g.get("passed") for g in guardrails):
        reasons.append("a guardrail failed")
    return {"within": not reasons, "reasons": reasons, "limits": b}


def check_budget(report: dict, gate: dict, guardrails: list[dict], budget: dict | None = None) -> dict:
    """Returns within=True only when every limit holds. Evidence that is absent counts as over budget."""
    if report.get("kind") == "host":
        return check_host_budget(report, gate, guardrails, budget)
    b = {**DEFAULT_BUDGET, **(budget or {})}
    reasons: list[str] = []
    totals = report.get("totals", {})
    if not totals:
        reasons.append("no measurements from the rehearsal")
    # Measured as well as classified: a function body or a CTE can hide a DELETE from the gate, not from this.
    if gate.get("highest_risk") == "irreversible_write" or totals.get("rows_deleted", 0) > 0:
        reasons.append(IRREVERSIBLE_REASON)
    if report.get("unlogged_changes"):
        reasons.append("rows changed with no row-level record, so the numbers here do not cover this change")
    executable = [d["name"] for d in report.get("schema_diff", []) if d.get("kind") in ("trigger", "function", "rule") and d.get("change") != "removed"]
    if executable:
        reasons.append("the plan adds code that keeps running on prod: " + ", ".join(executable[:3]))
    if totals.get("rows_changed", 0) > b["max_rows_changed"]:
        reasons.append(f"{totals['rows_changed']} rows changed; budget is {b['max_rows_changed']}")
    if totals.get("rows_via_cascade", 0) > b["max_cascade_rows"]:
        reasons.append(f"{totals['rows_via_cascade']} rows changed by cascade; budget is {b['max_cascade_rows']}")
    for t in report.get("tables", []):
        pct = t.get("pct_of_table")
        # Very small tables would trip a percentage on a single row, so the row budget covers those.
        if pct is not None and pct > b["max_table_pct"] and (t.get("rows_before") or 0) > b["max_rows_changed"]:
            reasons.append(f"{pct}% of {t['table']} touched; budget is {b['max_table_pct']}%")
    if totals.get("tables_dropped") and not b["allow_drop"]:
        reasons.append(f"{totals['tables_dropped']} table(s) dropped")
    if totals.get("tables_truncated") and not b["allow_truncate"]:
        reasons.append(f"{totals['tables_truncated']} table(s) truncated")
    if report.get("capture_gaps"):
        reasons.append("the row log missed changes that Postgres counted, so this report cannot be trusted")
    removed = [d for d in report.get("schema_diff", []) if d["change"] == "removed"]
    if removed:
        reasons.append(f"{len(removed)} schema object(s) removed")
    if not b["allow_ddl"] and report.get("ddl"):
        reasons.append("the plan changes the schema")
    if gate.get("verdict") != "pass":
        reasons.append(f"static gate verdict is {gate.get('verdict')}")
    if any(not g.get("passed") for g in guardrails):
        reasons.append("a guardrail failed")
    return {"within": not reasons, "reasons": reasons, "limits": b}
