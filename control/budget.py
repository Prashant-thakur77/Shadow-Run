"""Blast-radius budget per target: small safe changes go through without waiting for a person."""
from __future__ import annotations

# auto_apply_scope and auto_apply_paths default to nothing: a change has to be named as low-risk to skip a person.
# Told only a row budget, an attacker model corrupted money in under 100 rows and passed every guardrail.
DEFAULT_BUDGET = {"max_rows_changed": 100, "max_table_pct": 10.0, "max_cascade_rows": 0, "allow_drop": False, "allow_truncate": False, "allow_ddl": True, "auto_apply_scope": {}}


DEFAULT_HOST_BUDGET = {"max_files_deleted": 20, "max_files_changed": 5, "max_services_stopped": 0, "auto_apply_paths": []}


IRREVERSIBLE_REASON = "the plan contains an irreversible write (DELETE, DROP, TRUNCATE, rm), which always needs a person"


def outside_scope(report: dict, scope: dict) -> list[str]:
    """What this plan changed that nobody listed as safe to change alone. scope is {table: "*" or [columns]}."""
    reasons: list[str] = []
    columns = report.get("changed_columns")
    for t in report.get("tables", []):
        name = t["table"]
        if not (t.get("inserted") or t.get("updated") or t.get("deleted") or t.get("dropped") or t.get("truncated")):
            continue
        allowed = scope.get(name)
        if allowed is None:
            reasons.append(f"{name} is not on the auto-apply list")
        elif allowed != "*":
            if t.get("inserted") or t.get("deleted") or t.get("dropped") or t.get("truncated"):
                reasons.append(f"rows were added or removed in {name}, where only {', '.join(allowed)} may change without a person")
            if t.get("updated") and columns is None:
                reasons.append(f"rows changed in {name}, and the columns they changed were not measured")
            outside = [c for c in (columns or {}).get(name, {}) if c not in allowed]
            if outside:
                reasons.append(f"{name}.{outside[0]} is not on the auto-apply list")
    for d in report.get("schema_diff", []):
        table = d["name"].split(".")[0]
        if scope.get(table) != "*":
            reasons.append(f"schema change on {table} is not on the auto-apply list")
    return reasons


def outside_paths(report: dict, paths: list[str]) -> list[str]:
    """Same rule for files. The list of files in a report is capped, so a longer change can't be cleared by it."""
    files = report.get("files") or {}
    touched = [*files.get("created", []), *files.get("changed", []), *files.get("deleted", [])]
    counted = sum((files.get("counts") or {}).get(k, 0) for k in ("created", "changed", "deleted"))
    if counted > len(touched):
        return [f"{counted} files changed, more than the report lists, so they can't be checked against the auto-apply paths"]
    outside = [p for p in touched if not any(p.startswith(prefix) for prefix in paths)]
    return [f"{len(outside)} file(s) changed outside the auto-apply paths, such as {outside[0]}"] if outside else []


# A plan with no person looking runs as root on a host, in the same guest as the code measuring it, so it could replace
# what measures it. So it's limited to plain commands, and every path it names has to be inside the auto-apply paths.
NO_PERSON_COMMANDS = {"echo", "printf", "cat", "touch", "mkdir", "cp", "mv", "tee", "gzip", "gunzip", "date", "ls", "true", "test", "[", "wc", "head", "tail", "grep", "sort", "uniq", "du", "df"}


def no_person_shell_reasons(no_person: dict, paths: list[str]) -> list[str]:
    reasons = [f"this needs a person because {p}" for p in sorted(set(no_person.get("problems") or []))]
    unlisted = sorted({c for c in no_person.get("commands") or [] if c not in NO_PERSON_COMMANDS})
    if unlisted:
        reasons.append(f"{unlisted[0]} isn't one of the plain commands that may run with no person")
    for word in no_person.get("words") or []:
        if any(ch in word for ch in "$`{}~") or ".." in word:
            reasons.append(f"a path in this plan can't be read for certain: {word[:60]}")
        elif "/" in word and word.startswith(("/", ">")) and word != "/dev/null" and not any(word.startswith(prefix) for prefix in paths):
            reasons.append(f"it names a path outside the auto-apply paths: {word[:60]}")
    return reasons


def check_host_budget(report: dict, gate: dict, guardrails: list[dict], budget: dict | None = None) -> dict:
    b = {**DEFAULT_HOST_BUDGET, **(budget or {})}
    reasons: list[str] = []
    totals = report.get("totals", {})
    if not totals:
        reasons.append("no measurements from the rehearsal")
    files = report.get("files")
    if files is not None and "outside_measured" not in files:
        reasons.append("changes outside the hashed folders were not measured")
    elif files and files["outside_measured"]:
        reasons.append(f"{files['counts']['outside_measured']} path(s) changed outside the folders hashed here, such as {files['outside_measured'][0]}")
    # Measured as well as classified: a wrapper such as `bash -c` can hide rm from the gate, not from this.
    if gate.get("highest_risk") == "irreversible_write" or totals.get("files_deleted", 0) > 0:
        reasons.append(IRREVERSIBLE_REASON)
    if totals.get("files_deleted", 0) > b["max_files_deleted"]:
        reasons.append(f"{totals['files_deleted']} files deleted; budget is {b['max_files_deleted']}")
    if totals.get("files_changed", 0) > b["max_files_changed"]:
        reasons.append(f"{totals['files_changed']} files changed; budget is {b['max_files_changed']}")
    if totals.get("services_stopped", 0) > b["max_services_stopped"]:
        reasons.append(f"{totals['services_stopped']} service(s) stopped; budget is {b['max_services_stopped']}")
    if report.get("services_started"):
        reasons.append("the plan starts a service: " + ", ".join(report["services_started"][:3]))
    if totals.get("ports_closed", 0) > 0:
        reasons.append(f"{totals['ports_closed']} port(s) stopped listening")
    if b.get("auto_apply_paths") is not None:
        reasons.extend(outside_paths(report, b["auto_apply_paths"]))
        if gate.get("no_person"):
            reasons.extend(no_person_shell_reasons(gate["no_person"], b["auto_apply_paths"]))
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
    if "sequences_unexplained" in report and report["sequences_unexplained"] is None:
        reasons.append("sequences were not measured")
    elif report.get("sequences_unexplained"):
        reasons.append(f"a sequence moved with no new row, which doesn't roll back: {report['sequences_unexplained'][0]['name']}")
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
    if b.get("auto_apply_scope") is not None:
        reasons.extend(outside_scope(report, b["auto_apply_scope"]))
    functions = sorted(set((gate.get("no_person") or {}).get("functions") or []))
    if functions:
        reasons.append(f"it calls {functions[0]}, which isn't one of the functions that may run with no person")
    moved = [m["name"] for m in report.get("metrics", []) if m.get("before") != m.get("after")]
    if moved:
        reasons.append("a business number moved: " + ", ".join(moved[:3]))
    if gate.get("verdict") != "pass":
        reasons.append(f"static gate verdict is {gate.get('verdict')}")
    if any(not g.get("passed") for g in guardrails):
        reasons.append("a guardrail failed")
    return {"within": not reasons, "reasons": reasons, "limits": b}
