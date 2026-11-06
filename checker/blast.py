"""Turn the raw measurements from a clone into the blast-radius report.

Every number here comes from Postgres inside the clone. No model is involved.
"""
from __future__ import annotations

from collections import defaultdict, deque
from typing import Any

OP_VERB = {"DELETE": "deleted", "UPDATE": "updated", "INSERT": "inserted", "TRUNCATE": "truncated"}


def _short(name: str) -> str:
    return name.split(".")[-1].strip('"')


def fk_children(foreign_keys: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for fk in foreign_keys:
        out[_short(fk["parent"])].append({"child": _short(fk["child"]), "on_delete": fk["on_delete"]})
    return out


def cascade_path(source_tables: set[str], target: str, children: dict[str, list[dict]]) -> list[dict] | None:
    """Shortest FK path from any table the step touched directly to the cascaded table."""
    queue = deque((s, []) for s in sorted(source_tables))
    seen = set(source_tables)
    while queue:
        table, path = queue.popleft()
        for edge in children.get(table, []):
            hop = {"parent": table, "child": edge["child"], "on_delete": edge["on_delete"]}
            if edge["child"] == target:
                return path + [hop]
            if edge["child"] not in seen and edge["on_delete"] in ("CASCADE", "SET NULL", "SET DEFAULT"):
                seen.add(edge["child"])
                queue.append((edge["child"], path + [hop]))
    return None


def _metric_deltas(metrics: list[dict]) -> list[dict]:
    out = []
    for m in metrics:
        before, after = m.get("before"), m.get("after")
        out.append({**m, "delta": None if before is None or after is None else round(after - before, 2), "lost_entirely": before is not None and after is None})
    return out


def build_report(result: dict, thresholds: dict | None = None) -> dict[str, Any]:
    changes = result.get("changes", [])
    before = result.get("table_rows_before", {})
    after = result.get("table_rows_after", {})
    children = fk_children(result.get("foreign_keys", []))

    direct_by_step: dict[int, set[str]] = defaultdict(set)
    for c in changes:
        if c["via"] == "direct":
            direct_by_step[c["step"]].add(c["table"])

    per_table: dict[str, dict[str, Any]] = {}
    sentences: list[dict] = []
    edges: dict[tuple[str, str], dict] = {}

    def table_rec(name: str) -> dict:
        return per_table.setdefault(
            name,
            {"table": name, "rows_before": before.get(name), "rows_after": after.get(name), "inserted": 0,
             "updated": 0, "deleted": 0, "direct": 0, "cascade": 0, "dropped": False, "truncated": False, "via": []},
        )

    for c in changes:
        rec = table_rec(c["table"])
        key = {"INSERT": "inserted", "UPDATE": "updated", "DELETE": "deleted", "TRUNCATE": "deleted"}[c["op"]]
        rec[key] += c["rows"]
        rec[c["via"]] += c["rows"]
        if c["op"] == "TRUNCATE":
            rec["truncated"] = True
        verb = OP_VERB[c["op"]]
        if c["via"] == "direct":
            sentences.append({
                "step": c["step"], "table": c["table"], "op": c["op"], "rows": c["rows"], "via": "direct",
                "path": None, "text": f"{c['rows']} {c['table']} {verb} directly (step {c['step']})",
            })
        else:
            path = cascade_path(direct_by_step.get(c["step"], set()), c["table"], children)
            if path:
                origin = path[0]["parent"]
                route = " → ".join([origin] + [f"{h['child']} ({h['on_delete']})" for h in path])
                text = f"{c['rows']} {c['table']} {verb} via cascade from {origin} (step {c['step']})"
                rec["via"].append(route)
                for hop in path:
                    e = edges.setdefault((hop["parent"], hop["child"]), {"from": hop["parent"], "to": hop["child"], "on_delete": hop["on_delete"], "rows": 0})
                    if hop["child"] == c["table"]:
                        e["rows"] += c["rows"]
            else:
                route = None
                text = f"{c['rows']} {c['table']} {verb} indirectly by a database trigger (step {c['step']})"
            sentences.append({
                "step": c["step"], "table": c["table"], "op": c["op"], "rows": c["rows"], "via": "cascade",
                "path": route, "text": text,
            })

    # A dropped table has no row-level log, but its row count before the plan is known.
    for name, n in before.items():
        if name not in after:
            rec = table_rec(name)
            rec["dropped"] = True
            rec["rows_after"] = None
            rec["deleted"] = n
            step = next((d["step"] for d in result.get("ddl", []) if d["tag"] == "DROP" and _short(d.get("identity") or "") == name), None)
            sentences.append({
                "step": step, "table": name, "op": "DROP", "rows": n, "via": "direct", "path": None,
                "text": f"table {name} dropped with {n} rows (step {step})",
            })

    for u in result.get("unlogged_changes", []):
        if u["table"] != "(all)":
            table_rec(u["table"])["unlogged"] = True
        sentences.append({"step": None, "table": u["table"], "op": "REWRITE", "rows": None, "via": "direct", "path": None, "text": f"{u['table']}: {u['detail']}"})

    for rec in per_table.values():
        base = rec["rows_before"] or 0
        rec["pct_of_table"] = round(100.0 * (rec["updated"] + rec["deleted"]) / base, 1) if base else None
    tables = sorted(per_table.values(), key=lambda r: -(r["deleted"] + r["updated"] + r["inserted"]))

    totals = {
        "rows_inserted": sum(t["inserted"] for t in tables),
        "rows_updated": sum(t["updated"] for t in tables),
        "rows_deleted": sum(t["deleted"] for t in tables),
        "rows_via_cascade": sum(t["cascade"] for t in tables),
        "tables_touched": len(tables),
        "tables_dropped": sum(1 for t in tables if t["dropped"]),
        "tables_truncated": sum(1 for t in tables if t["truncated"]),
        "ddl_commands": len(result.get("ddl", [])),
    }
    totals["rows_changed"] = totals["rows_inserted"] + totals["rows_updated"] + totals["rows_deleted"]

    # Cascades first: those are what the plan's text does not say.
    sentences.sort(key=lambda s: (s["op"] != "REWRITE", s["via"] != "cascade", -(s["rows"] or 0)))
    return {
        "totals": totals,
        "tables": tables,
        "sentences": sentences,
        "cascade_graph": {
            "nodes": [{"table": t["table"], "deleted": t["deleted"], "updated": t["updated"], "direct": t["direct"], "cascade": t["cascade"]} for t in tables],
            "edges": list(edges.values()),
        },
        "samples": result.get("samples", {}),
        "ddl": result.get("ddl", []),
        "schema_diff": result.get("schema_diff", []),
        "changed_columns": result.get("changed_columns"),
        "xact_counts": result.get("xact_counts", {}),
        "capture_gaps": result.get("capture_gaps", []),
        "unlogged_changes": result.get("unlogged_changes", []),
        "metrics": _metric_deltas(result.get("metrics", [])),
    }


def build_host_report(result: dict) -> dict[str, Any]:
    """Blast radius for a Linux host: files and services, measured around the plan's steps."""
    files = result.get("files", {})
    counts = files.get("counts", {})
    sentences: list[dict] = []

    def line(text: str, kind: str, n: int | None = None) -> None:
        sentences.append({"step": None, "table": None, "op": kind, "rows": n, "via": "direct", "path": None, "text": text})

    for unit in result.get("services_stopped", []):
        line(f"service {unit} stopped", "SERVICE_STOPPED")
    for port in result.get("ports_closed", []):
        line(f"port {port} no longer listening", "PORT_CLOSED")
    if counts.get("deleted"):
        line(f"{counts['deleted']} files deleted ({files.get('bytes_freed', 0)} bytes freed)", "DELETE", counts["deleted"])
    if counts.get("changed"):
        line(f"{counts['changed']} files changed", "UPDATE", counts["changed"])
    if counts.get("created"):
        line(f"{counts['created']} files created", "INSERT", counts["created"])
    for unit in result.get("services_started", []):
        line(f"service {unit} started", "SERVICE_STARTED")

    groups: dict[str, int] = defaultdict(int)
    for path in files.get("deleted", []):
        parts = path.split("/")
        groups["/".join(parts[:5])] += 1
    return {
        "kind": "host",
        "totals": {
            "files_created": counts.get("created", 0),
            "files_deleted": counts.get("deleted", 0),
            "files_changed": counts.get("changed", 0),
            "bytes_freed": files.get("bytes_freed", 0),
            "services_stopped": len(result.get("services_stopped", [])),
            "ports_closed": len(result.get("ports_closed", [])),
            "rows_changed": 0,
            "rows_via_cascade": 0,
            "tables_touched": 0,
            "rows_inserted": 0,
            "rows_updated": 0,
            "rows_deleted": 0,
            "tables_dropped": 0,
            "tables_truncated": 0,
            "ddl_commands": 0,
        },
        "sentences": sentences,
        "files": files,
        "deleted_by_directory": [{"path": k, "files": v} for k, v in sorted(groups.items(), key=lambda kv: -kv[1])[:20]],
        "services_stopped": result.get("services_stopped", []),
        "services_started": result.get("services_started", []),
        "ports_closed": result.get("ports_closed", []),
        "services_after": result.get("services_after", {}),
        "tables": [],
        "cascade_graph": {"nodes": [], "edges": []},
        "samples": {},
        "ddl": [],
        "schema_diff": [],
        "xact_counts": {},
    }
