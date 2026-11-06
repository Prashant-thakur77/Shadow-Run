"""Run a frozen plan inside one transaction and measure what it did.

The same file runs inside the sandbox (rehearsal) and on the control plane (apply), so the
rehearsal and the apply cannot drift apart in how they execute a plan or count its effects.
Standard library + psycopg only, because it is copied into the sandbox image.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any, Callable, Iterable

COUNTS_SQL = """
SELECT relname, n_tup_ins::bigint, n_tup_upd::bigint, n_tup_del::bigint
FROM pg_stat_xact_user_tables
WHERE schemaname NOT LIKE 'pg_temp%%' AND schemaname <> 'shadow'
ORDER BY relname
"""

SCHEMA_SQL = """
SELECT 'column' AS kind, table_name || '.' || column_name AS name,
       data_type || ':' || is_nullable || ':' || coalesce(column_default, '') AS detail
FROM information_schema.columns WHERE table_schema = 'public'
UNION ALL
SELECT 'index', tablename || '.' || indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
UNION ALL
SELECT 'constraint', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid)
FROM pg_constraint WHERE connamespace = 'public'::regnamespace
UNION ALL
SELECT 'view', viewname, definition FROM pg_views WHERE schemaname = 'public'
UNION ALL
SELECT 'trigger', c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT t.tgisinternal AND n.nspname = 'public' AND t.tgname NOT LIKE 'zz_shadow_%'
UNION ALL
SELECT 'function', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid))
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p')
UNION ALL
SELECT 'rule', tablename || '.' || rulename, definition FROM pg_rules WHERE schemaname = 'public'
ORDER BY 1, 2
"""

# Row content is compared between rehearsal and apply, but a timestamp set from now() legitimately
# differs, and so does its text across time zones. For these types only NULL or not is compared, so
# `deleted_at = now()` still matches while setting it on different rows does not.
TIME_TYPES = {"timestamp without time zone", "timestamp with time zone", "date", "time without time zone", "time with time zone"}

TABLES_SQL = """
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1
"""

BEFORE_REF = re.compile(r"\bbefore\.([a-zA-Z_][a-zA-Z0-9_]*)")


def quote_ident(name: str) -> str:
    """Table names come from the database, and a plan can create any name it likes."""
    return '"' + name.replace('"', '""') + '"'


def sha256_json(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def schema_state(cur) -> list[list[str]]:
    cur.execute(SCHEMA_SQL)
    return [list(r) for r in cur.fetchall()]


def table_counts(cur) -> dict[str, int]:
    cur.execute(TABLES_SQL)
    names = [r[0] for r in cur.fetchall()]
    out: dict[str, int] = {}
    for name in names:
        cur.execute(f"SELECT count(*) FROM public.{quote_ident(name)}")
        out[name] = cur.fetchone()[0]
    return out


def table_checksums(cur, names: Iterable[str] | None = None) -> dict[str, dict[str, Any]]:
    """Row count + order-independent hash per table. Detects drift between rehearsal and apply.

    A sum of 64-bit row hashes needs no sort, so it stays cheap on large tables. It detects change,
    and is not meant to resist someone deliberately crafting a collision.
    """
    if names is None:
        cur.execute(TABLES_SQL)
        names = [r[0] for r in cur.fetchall()]
    out: dict[str, dict[str, Any]] = {}
    for name in names:
        ident = f"public.{quote_ident(name)}"
        cur.execute("SELECT to_regclass(%s)", (ident,))
        if cur.fetchone()[0] is None:
            out[name] = {"rows": None, "hash": None}
            continue
        cur.execute(f"SELECT count(*), coalesce(sum(hashtextextended(t::text, 42)::numeric), 0)::text FROM {ident} t")
        rows, digest = cur.fetchone()
        out[name] = {"rows": rows, "hash": digest}
    return out


def table_columns(cur) -> dict[str, list[list[str]]]:
    cur.execute(
        """SELECT table_name, column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"""
    )
    out: dict[str, list[list[str]]] = {}
    for table, column, kind in cur.fetchall():
        out.setdefault(table, []).append([column, kind])
    return out


def content_hashes(cur, columns: dict[str, list[list[str]]]) -> dict[str, dict[str, Any]]:
    """Row count + hash of row content per table, order independent. See TIME_TYPES."""
    out: dict[str, dict[str, Any]] = {}
    for table, cols in columns.items():
        ident = f"public.{quote_ident(table)}"
        cur.execute("SELECT to_regclass(%s)", (ident,))
        if cur.fetchone()[0] is None:
            out[table] = {"rows": None, "hash": None}
            continue
        parts = [f"({quote_ident(c)} IS NULL)" if kind in TIME_TYPES else quote_ident(c) for c, kind in cols]
        row = f"ROW({', '.join(parts)})::text" if parts else "''"
        cur.execute(f"SELECT count(*), coalesce(sum(hashtextextended({row}, 42)::numeric), 0)::text FROM {ident}")
        rows, digest = cur.fetchone()
        out[table] = {"rows": rows, "hash": digest}
    return out


def content_mismatch(expected: dict[str, dict], actual: dict[str, dict]) -> list[dict]:
    return [{"table": t, "rehearsal": expected.get(t), "actual": actual.get(t)} for t in sorted(set(expected) | set(actual)) if expected.get(t) != actual.get(t)]


def rewrite_before(sql: str) -> str:
    """Guardrails read pre-plan data as before.<table>; that resolves to a temp copy."""
    return BEFORE_REF.sub(lambda m: f"pg_temp.{quote_ident('before_' + m.group(1))}", sql)


def before_tables(guardrails: list[dict]) -> list[str]:
    found: set[str] = set()
    for g in guardrails:
        found.update(BEFORE_REF.findall(g["sql"]))
    return sorted(found)


def snapshot_before(cur, tables: list[str]) -> dict[str, tuple]:
    """Copy tables for before.<table>, and return a digest of each copy.

    The plan runs in this session as the role that owns these temp tables, so it could rewrite them to
    agree with its own damage. The digests are held in this process, where SQL cannot reach them.
    """
    digests: dict[str, tuple] = {}
    for t in tables:
        cur.execute("SELECT to_regclass(%s)", (f"public.{quote_ident(t)}",))
        if cur.fetchone()[0] is None:
            raise RuntimeError(f"guardrail references before.{t}, but table {t} does not exist")
        name = quote_ident("before_" + t)
        cur.execute(f"CREATE TEMP TABLE {name} ON COMMIT DROP AS TABLE public.{quote_ident(t)}")
        digests[t] = _baseline_digest(cur, name)
    return digests


def _baseline_digest(cur, name: str) -> tuple:
    cur.execute(f"SELECT count(*), coalesce(sum(hashtextextended(x::text, 42)::numeric), 0)::text FROM pg_temp.{name} x")
    return tuple(cur.fetchone())


def verify_before(cur, digests: dict[str, tuple]) -> str | None:
    """None if the guardrail baselines are intact, or a reason. A baseline the plan touched is a failure."""
    for t, digest in digests.items():
        try:
            cur.execute("SAVEPOINT sr_baseline")
            now = _baseline_digest(cur, quote_ident("before_" + t))
            cur.execute("RELEASE SAVEPOINT sr_baseline")
        except Exception as e:
            cur.execute("ROLLBACK TO SAVEPOINT sr_baseline")
            return f"the plan removed the guardrail baseline for {t}: {_oneline(e)}"
        if now != digest:
            return f"the plan changed the guardrail baseline for {t}"
    return None


def run_guardrails(cur, guardrails: list[dict]) -> list[dict]:
    """A guardrail is frozen SQL that must return 0 rows. Runs inside the plan's transaction."""
    results = []
    # pg_catalog first: a plan must not be able to shadow sum() or count() with its own function.
    cur.execute("SET LOCAL search_path = pg_catalog, public, pg_temp")
    for g in guardrails:
        t0 = time.perf_counter()
        item: dict[str, Any] = {"id": g["id"], "name": g.get("name", g["id"])}
        cur.execute("SAVEPOINT sr_guardrail")
        try:
            cur.execute(rewrite_before(g["sql"]))
            rows = cur.fetchmany(6)
            cols = [d.name for d in cur.description] if cur.description else []
            item.update(
                passed=len(rows) == 0,
                violations=[dict(zip(cols, [_plain(v) for v in r])) for r in rows[:5]],
                violation_count_capped=len(rows),
            )
            cur.execute("RELEASE SAVEPOINT sr_guardrail")
        except Exception as e:  # a guardrail that cannot run counts as failed, never as passed
            cur.execute("ROLLBACK TO SAVEPOINT sr_guardrail")
            item.update(passed=False, violations=[], error=_oneline(e))
        item["ms"] = round((time.perf_counter() - t0) * 1000, 1)
        results.append(item)
    return results


def run_statements(
    conn,
    cur,
    steps: list[dict],
    on_step: Callable[[int], None] | None = None,
) -> tuple[list[dict], str | None]:
    """Execute every statement of every step in the open transaction. Stops at the first error.

    Deferred triggers are forced to fire at the end, so they happen inside the measured window and not
    at COMMIT, after the counts and guardrails have already been read.
    """
    out: list[dict] = []
    for idx, step in enumerate(steps, start=1):
        if on_step:
            on_step(idx)
        step_rec: dict[str, Any] = {"step": idx, "statements": [], "ok": True}
        for stmt in step["statements"]:
            t0 = time.perf_counter()
            rec: dict[str, Any] = {"sql": stmt}
            try:
                cur.execute(stmt)
                rec["tag"] = cur.statusmessage
                rec["rowcount"] = cur.rowcount
                rec["ok"] = True
            except Exception as e:
                rec["ok"] = False
                rec["error"] = _oneline(e)
            rec["ms"] = round((time.perf_counter() - t0) * 1000, 1)
            step_rec["statements"].append(rec)
            if not rec["ok"]:
                step_rec["ok"] = False
                out.append(step_rec)
                return out, rec["error"]
            # A plan must not be able to end the transaction it runs in. The gate rejects this
            # before rehearsal; this catches it at runtime if the gate is ever bypassed.
            if _tx_status(conn) != "INTRANS":
                step_rec["ok"] = False
                out.append(step_rec)
                return out, f"statement ended the enclosing transaction: {stmt[:80]}"
        out.append(step_rec)
    try:
        cur.execute("SET CONSTRAINTS ALL IMMEDIATE")
    except Exception as e:
        return out, f"a deferred constraint or trigger failed: {_oneline(e)}"
    return out, None


def xact_counts(cur) -> dict[str, dict[str, int]]:
    # Per-table insert/update/delete counts for this transaction, cascades included.
    cur.execute("SELECT pg_stat_clear_snapshot()")
    cur.execute(COUNTS_SQL)
    return {r[0]: {"ins": r[1], "upd": r[2], "del": r[3]} for r in cur.fetchall() if r[1] or r[2] or r[3]}


def counts_mismatch(expected: dict[str, dict[str, int]], actual: dict[str, dict[str, int]]) -> list[dict]:
    diffs = []
    zero = {"ins": 0, "upd": 0, "del": 0}
    for table in sorted(set(expected) | set(actual)):
        e, a = expected.get(table, zero), actual.get(table, zero)
        if e != a:
            diffs.append({"table": table, "rehearsal": e, "actual": a})
    return diffs


def _tx_status(conn) -> str:
    return conn.info.transaction_status.name


def _oneline(e: Exception) -> str:
    return " ".join(str(e).split())[:500]


def _plain(v: Any) -> Any:
    if v is None or isinstance(v, (int, float, bool, str)):
        return v
    return str(v)
