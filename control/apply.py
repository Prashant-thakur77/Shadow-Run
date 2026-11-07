"""Run the approved plan on prod in one transaction. COMMIT only if it matches the rehearsal.

Order inside the transaction: lock the tables the rehearsal touched, re-check them for drift under
that lock (closing the gap between check and run), execute, compare counts and schema, run the
guardrails, and only then COMMIT. Anything else is a ROLLBACK. Same txrun.py as the rehearsal.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import psycopg

from control import gate as static_gate
from control.snapshot import ProdConn
from runner.guest import txrun

log = logging.getLogger("shadowrun.apply")


def _undo_sequence_moves(conn: Any, cur: Any, moved: list[dict]) -> None:
    """ROLLBACK doesn't touch a sequence, so "nothing was applied" is only true once these are put back."""
    for m in moved:
        cur.execute("SELECT setval(%s::regclass, %s, true)", (m["name"], m["before"]))
    conn.commit()


def apply_plan(
    conn_info: ProdConn,
    steps: list[dict],
    guardrails: list[dict],
    rehearsal: dict,
    snapshot_tables: dict,
    *,
    check_drift: bool = True,
    statement_timeout_ms: int = 60000,
) -> dict[str, Any]:
    """Returns outcome: committed | drift_detected | rolled_back. Never raises for a plan failure."""
    t0 = time.perf_counter()
    expected_counts = rehearsal.get("xact_counts", {})
    expected_schema = rehearsal.get("schema_fingerprint_after")
    touched = [t for t in rehearsal.get("touched_tables", []) if t in snapshot_tables]
    out: dict[str, Any] = {"outcome": None, "touched_tables": touched, "expected_counts": expected_counts}

    # Guardrails are checked when they're accepted. This is the last look before one runs on prod.
    for g in guardrails:
        unsafe = static_gate.check_guardrail(g["sql"])
        if unsafe:
            out.update(outcome="rolled_back", reason=f"guardrail {g.get('name', g.get('id'))} can't run on prod: {unsafe}. Nothing was applied.", guardrails=[])
            return out

    conn = psycopg.connect(**conn_info.kwargs())
    try:
        cur = conn.cursor()
        cur.execute(f"SET LOCAL statement_timeout = {int(statement_timeout_ms)}")
        cur.execute("SET LOCAL lock_timeout = 5000")

        if check_drift and touched:
            for t in touched:
                ident = f"public.{txrun.quote_ident(t)}"
                cur.execute("SELECT to_regclass(%s)", (ident,))
                if cur.fetchone()[0] is not None:
                    cur.execute(f"LOCK TABLE {ident} IN SHARE ROW EXCLUSIVE MODE")
            current = txrun.table_checksums(cur, touched)
            drifted = [t for t in touched if current.get(t) != snapshot_tables.get(t)]
            out["drift_checked"] = touched
            if drifted:
                conn.rollback()
                out.update(
                    outcome="drift_detected",
                    drifted_tables=[{"table": t, "at_rehearsal": snapshot_tables.get(t), "now": current.get(t)} for t in drifted],
                    reason="Prod changed since the rehearsal, so the rehearsal no longer describes what this plan would do. Nothing was applied.",
                )
                return out
        else:
            out["drift_checked"] = []

        baselines = txrun.snapshot_before(cur, txrun.before_tables(guardrails))
        sequences_before = txrun.sequence_state(cur)
        rehearsed_moves = rehearsal.get("sequences_moved") or []

        def sequences_gone_wrong() -> list[dict]:
            return txrun.unexpected_sequence_moves(txrun.moved_sequences(sequences_before, txrun.sequence_state(cur)), rehearsed_moves)

        step_results, error = txrun.run_statements(conn, cur, steps)
        out["steps"] = step_results
        error = error or txrun.verify_before(cur, baselines)
        if error:
            conn.rollback()
            restored = sequences_gone_wrong()
            _undo_sequence_moves(conn, cur, restored)
            out.update(outcome="rolled_back", reason=f"a statement failed on prod: {error}", sequences_restored=restored)
            return out

        actual = txrun.xact_counts(cur)
        out["actual_counts"] = actual
        diffs = txrun.counts_mismatch(expected_counts, actual)
        cur.execute("RESET search_path")
        schema_now = txrun.sha256_json(txrun.schema_state(cur))
        out["schema_matches"] = schema_now == expected_schema
        guard = txrun.run_guardrails(cur, guardrails)
        out["guardrails"] = guard
        failed = [g for g in guard if not g["passed"]]

        # Same counts can still mean different rows, for example a plan that branches on current_user,
        # so compare the content of every table the rehearsal touched.
        expected_content = rehearsal.get("content_after", {})
        columns = txrun.table_columns(cur)
        actual_content = txrun.content_hashes(cur, {t: columns.get(t, []) for t in expected_content})
        content_diffs = txrun.content_mismatch(expected_content, actual_content)

        reasons = []
        wrong_sequences = sequences_gone_wrong()
        if wrong_sequences:
            out["sequence_mismatches"] = wrong_sequences
            reasons.append(f"sequence {wrong_sequences[0]['name']} moved on prod in a way the rehearsal didn't show")
        if content_diffs:
            out["content_mismatches"] = content_diffs
            reasons.append(f"row content differs from the rehearsal on {len(content_diffs)} table(s)")
        if diffs:
            out["count_mismatches"] = diffs
            reasons.append(f"row counts differ from the rehearsal on {len(diffs)} table(s)")
        if not out["schema_matches"]:
            reasons.append("the resulting schema differs from the rehearsal")
        if failed:
            reasons.append("guardrail failed on prod: " + ", ".join(g["name"] for g in failed))
        if reasons:
            conn.rollback()
            restored = sequences_gone_wrong()
            _undo_sequence_moves(conn, cur, restored)
            out.update(outcome="rolled_back", reason="; ".join(reasons), sequences_restored=restored)
            return out

        conn.commit()
        out.update(outcome="committed", reason="Counts, schema and guardrails all matched the rehearsal.")
        return out
    except psycopg.Error as e:
        conn.rollback()
        out.update(outcome="rolled_back", reason=f"database error during apply: {' '.join(str(e).split())[:400]}")
        return out
    finally:
        out["ms"] = round((time.perf_counter() - t0) * 1000, 1)
        conn.close()


async def apply_host_plan(runner, host_id: str, steps: list[dict], guardrails: list[dict], expected: dict, snapshot_digest: str | None, *, check_drift: bool = True) -> dict[str, Any]:
    """No transaction on a filesystem: keep a state tar, compare to the rehearsal, restore on any mismatch."""
    t0 = time.perf_counter()
    out: dict[str, Any] = {"expected_files": expected.get("files", {}).get("counts"), "expected_services_stopped": expected.get("services_stopped")}
    now = await runner.host_fingerprint(host_id)
    if check_drift and now.get("digest") != snapshot_digest:
        out.update(outcome="drift_detected", drifted_tables=[], reason="The host changed since the rehearsal. Nothing was applied.", fingerprint_at_rehearsal=snapshot_digest, fingerprint_now=now.get("digest"))
        return out
    applied = await runner.host_apply(host_id, steps, guardrails)
    r = applied["result"]
    out["files"] = r.get("files", {}).get("counts")
    out["services_stopped"] = r.get("services_stopped")
    out["guardrails"] = r.get("guardrails")
    reasons = []
    if r.get("error"):
        reasons.append(f"a step failed on prod: {r['error'][:200]}")
    for key in ("created", "deleted", "changed"):
        if sorted(r.get("files", {}).get(key, [])) != sorted(expected.get("files", {}).get(key, [])):
            reasons.append(f"files {key} differ from the rehearsal")
    if r.get("files", {}).get("content_sha256") != expected.get("files", {}).get("content_sha256"):
        reasons.append("the content of changed files differs from the rehearsal")
    # Running services write here all the time, on prod and not on a fresh clone.
    service_noise = ("/var/log", "/var/lib", "/var/cache")
    shown = set(expected.get("files", {}).get("outside_measured") or [])
    surprise = [p for p in r.get("files", {}).get("outside_measured") or [] if p not in shown and not p.startswith(service_noise)]
    if surprise:
        reasons.append(f"it changed {surprise[0]} on prod, outside the hashed folders, which the rehearsal didn't show")
    if sorted(r.get("services_stopped", [])) != sorted(expected.get("services_stopped", [])):
        reasons.append("services stopped differ from the rehearsal")
    failed = [g["name"] for g in r.get("guardrails", []) if not g["passed"]]
    if failed:
        reasons.append("guardrail failed on prod: " + ", ".join(failed))
    if reasons:
        rollback = await runner.host_rollback(host_id, (applied.get("services_before") or {}).get("running", []))
        out.update(outcome="rolled_back", reason="; ".join(reasons), restored=rollback.get("ok"))
    else:
        out.update(outcome="committed", reason="Files, services and guardrails all matched the rehearsal.")
    out["ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return out
