#!/usr/bin/env python3
"""Runs inside the sandbox as root. Reads one JSON job on stdin, writes one JSON result on stdout.

The plan's SQL reaches Postgres as the unprivileged `agent` role; only this driver's second
connection is superuser. A plan cannot write to stdout here, so it cannot forge the result.
"""
from __future__ import annotations

import json
import os
import pwd
import re
import socket
import subprocess
import sys
import time

sys.path.insert(0, "/opt/sr/guest")
import psycopg  # noqa: E402
import txrun  # noqa: E402

PGBIN = "/usr/lib/postgresql/16/bin"
PGDATA = "/opt/sr/pgdata"
DB = "app"
MAX_SAMPLES = 5
CONTENT_BEFORE = "/opt/sr/content_before.json"


def sh_as_postgres(args: list[str], **kw) -> subprocess.CompletedProcess:
    pw = pwd.getpwnam("postgres")

    def demote():
        os.setgid(pw.pw_gid)
        os.setuid(pw.pw_uid)

    return subprocess.run(args, preexec_fn=demote, capture_output=True, text=True, cwd="/", **kw)


def start_postgres() -> dict:
    t0 = time.perf_counter()
    os.makedirs("/var/run/postgresql", exist_ok=True)
    pw = pwd.getpwnam("postgres")
    os.chown("/var/run/postgresql", pw.pw_uid, pw.pw_gid)
    # A forked clone inherits a running server through its memory image; start only when down.
    if sh_as_postgres([f"{PGBIN}/pg_isready", "-q", "-h", "/var/run/postgresql"]).returncode != 0:
        r = sh_as_postgres(
            [f"{PGBIN}/pg_ctl", "-w", "-t", "30", "-D", PGDATA, "-l", "/tmp/pg.log", "start"],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
        )
        if r.returncode != 0:
            raise RuntimeError(f"pg_ctl start failed: {r.stdout} {r.stderr}")
    return {"ms": round((time.perf_counter() - t0) * 1000, 1)}


def super_conn(dbname: str = DB, autocommit: bool = True):
    return psycopg.connect(f"host=/var/run/postgresql dbname={dbname} user=postgres", autocommit=autocommit)


def agent_conn(dbname: str = DB):
    return psycopg.connect(f"host=/var/run/postgresql dbname={dbname} user=agent")


def op_prepare(job: dict) -> dict:
    """Restore the snapshot and install capture. Output of this op is the golden clone state."""
    timing: dict = {"postgres_start_ms": start_postgres()["ms"]}
    with super_conn("postgres") as c:
        c.execute("CREATE ROLE agent LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE")
        c.execute(f"CREATE DATABASE {DB} OWNER agent")
    with super_conn() as c:
        for ext in job.get("extensions", []):
            c.execute(f'CREATE EXTENSION IF NOT EXISTS "{ext}"')
        c.execute("ALTER SCHEMA public OWNER TO agent")

    t0 = time.perf_counter()
    dump = job["dump_path"]
    # Local trust is by peer auth, so the restore runs as OS user postgres under SET ROLE agent.
    r = sh_as_postgres(
        [f"{PGBIN}/pg_restore", "-h", "/var/run/postgresql", "-U", "postgres", "--role=agent",
         "-O", "-x", "--no-comments", "-d", DB, dump]
    )
    timing["restore_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    restore_err = r.stderr.strip()[:2000]
    if r.returncode not in (0, 1):
        raise RuntimeError(f"pg_restore failed rc={r.returncode}: {restore_err}")

    t0 = time.perf_counter()
    with super_conn() as c:
        with open("/opt/sr/guest/capture.sql") as f:
            c.execute(f.read())
    timing["capture_install_ms"] = round((time.perf_counter() - t0) * 1000, 1)

    with super_conn() as c:
        cur = c.cursor()
        # Taken once per golden clone. Rehearsals only re-hash when a plan ran DDL, which is the one way
        # to change rows without firing a row trigger, so ordinary plans pay nothing for this.
        t0 = time.perf_counter()
        columns = txrun.table_columns(cur)
        with open(CONTENT_BEFORE, "w") as f:
            json.dump({"columns": columns, "hashes": txrun.content_hashes(cur, columns)}, f)
        timing["content_hash_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        c.execute("CHECKPOINT")
    return {"ok": True, "timing": timing, "restore_warnings": restore_err}


def op_seal(job: dict) -> dict:
    """Stop Postgres cleanly and delete the dump, so the golden disk holds only the restored clone."""
    r = sh_as_postgres([f"{PGBIN}/pg_ctl", "-D", PGDATA, "-m", "fast", "-w", "stop"])
    if os.path.exists(job["dump_path"]):
        os.remove(job["dump_path"])
    os.sync()
    return {"ok": r.returncode == 0, "detail": r.stderr.strip()[:300]}


def op_inspect(job: dict) -> dict:
    start_postgres()
    sample = int(job.get("sample_rows", 3))
    with super_conn() as c:
        cur = c.cursor()
        tables = []
        cur.execute(
            """SELECT c.relname, c.oid::regclass::text FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY 1"""
        )
        for name, _ in cur.fetchall():
            cur.execute(
                """SELECT column_name, data_type, is_nullable, column_default
                   FROM information_schema.columns WHERE table_schema='public' AND table_name=%s
                   ORDER BY ordinal_position""",
                (name,),
            )
            cols = [dict(zip(("name", "type", "nullable", "default"), r)) for r in cur.fetchall()]
            ident = f"public.{txrun.quote_ident(name)}"
            cur.execute(f"SELECT count(*) FROM {ident}")
            n = cur.fetchone()[0]
            cur.execute(f"SELECT to_jsonb(t) FROM {ident} t LIMIT %s", (sample,))
            rows = [r[0] for r in cur.fetchall()]
            tables.append({"name": name, "columns": cols, "row_count": n, "sample_rows": rows})
        fk = cascade_paths(cur)
        return {"ok": True, "tables": tables, "foreign_keys": fk}


def op_query(job: dict) -> dict:
    """Read-only queries for the agent, run as the unprivileged role in a read-only transaction."""
    start_postgres()
    out = []
    with agent_conn() as c:
        c.execute("SET TRANSACTION READ ONLY")
        c.execute("SET LOCAL statement_timeout = 10000")
        for sql in job["queries"][:5]:
            item = {"sql": sql}
            c.execute("SAVEPOINT q")
            try:
                cur = c.execute(sql)
                cols = [d.name for d in cur.description] if cur.description else []
                rows = cur.fetchmany(int(job.get("max_rows", 40)))
                item.update(ok=True, columns=cols, rows=[[txrun._plain(v) if not isinstance(v, str) else v[:2000] for v in r] for r in rows])
                c.execute("RELEASE SAVEPOINT q")
            except Exception as e:
                c.execute("ROLLBACK TO SAVEPOINT q")
                item.update(ok=False, error=txrun._oneline(e))
            out.append(item)
    return {"ok": True, "results": out}


SUSPECT_RE = (
    r"(ignore (your|all|previous|the)|system note|admin override|drop\s+table|truncate\s+\w+|delete\s+from|"
    r"do not mention|assistant:|as an ai|must first run|also run)"
)


def op_suspects(job: dict) -> dict:
    """Stored text that reads like instructions to an agent. Found by regex, judged later by a model."""
    start_postgres()
    found = []
    with super_conn() as c:
        cur = c.cursor()
        cur.execute(
            """SELECT table_name, column_name FROM information_schema.columns
               WHERE table_schema='public' AND data_type IN ('text','character varying')"""
        )
        for table, column in cur.fetchall():
            cur.execute(
                f"SELECT left({txrun.quote_ident(column)}, 1000) FROM public.{txrun.quote_ident(table)} WHERE {txrun.quote_ident(column)} ~* %s LIMIT 5",
                (SUSPECT_RE,),
            )
            for (text,) in cur.fetchall():
                found.append({"table": table, "column": column, "text": text})
    return {"ok": True, "suspects": found[:20]}


CASCADE_SQL = """
SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent,
       conname, confdeltype::text AS on_delete
FROM pg_constraint
WHERE contype = 'f' AND connamespace = 'public'::regnamespace
ORDER BY 2, 1, 3
"""

ON_DELETE = {"a": "NO ACTION", "r": "RESTRICT", "c": "CASCADE", "n": "SET NULL", "d": "SET DEFAULT"}


def cascade_paths(cur) -> list[dict]:
    cur.execute(CASCADE_SQL)
    return [
        {"child": r[0], "parent": r[1], "constraint": r[2], "on_delete": ON_DELETE.get(r[3], r[3])}
        for r in cur.fetchall()
    ]


def op_rehearse(job: dict) -> dict:
    timing: dict = {"postgres_start_ms": start_postgres()["ms"]}
    steps = job["steps"]
    guardrails = job.get("guardrails", [])
    sup = super_conn()
    scur = sup.cursor()
    scur.execute("UPDATE shadow.ctl SET step = 0")
    before_counts = txrun.table_counts(scur)
    before_schema = txrun.schema_state(scur)

    conn = agent_conn()
    cur = conn.cursor()
    cur.execute(f"SET statement_timeout = {int(job.get('statement_timeout_ms', 60000))}")
    cur.execute("SET lock_timeout = 5000")

    t0 = time.perf_counter()
    baselines = txrun.snapshot_before(cur, txrun.before_tables(guardrails))

    def on_step(i: int) -> None:
        scur.execute("UPDATE shadow.ctl SET step = %s", (i,))

    step_results, error = txrun.run_statements(conn, cur, steps, on_step)
    timing["execute_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    if error is None:
        error = txrun.verify_before(cur, baselines)

    guardrail_results: list[dict] = []
    counts: dict = {}
    committed = False
    if error is None:
        counts = txrun.xact_counts(cur)
        t0 = time.perf_counter()
        guardrail_results = txrun.run_guardrails(cur, guardrails)
        timing["guardrails_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        conn.commit()
        committed = True
    else:
        conn.rollback()
    conn.close()

    scur.execute("UPDATE shadow.ctl SET step = 0")
    t0 = time.perf_counter()
    report = collect(scur, before_counts, before_schema, committed, counts)
    timing["collect_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    sup.close()
    return {
        "ok": error is None,
        "error": error,
        "steps": step_results,
        "xact_counts": counts,
        "guardrails": guardrail_results,
        "timing": timing,
        "hostname": socket.gethostname(),
        "kernel": os.uname().release,
        **report,
    }


def ddl_tables(ddl: list[dict], known: set[str]) -> list[str]:
    """Tables a DDL command names. Identities look like public.users or public.users.email."""
    out = []
    for d in ddl:
        identity = d.get("identity") or ""
        for t in known:
            if identity == f"public.{t}" or identity.startswith(f"public.{t}.") or f" on public.{t}" in identity:
                out.append(t)
    return out


def capture_gaps(changes: list[dict], counts: dict) -> list[dict]:
    """Cross-check the row log against Postgres's own in-transaction statistics, which a plan cannot edit.

    A plan's role owns its tables, so it could try to disable the capture trigger. The gate refuses
    that, and this catches it if the gate is ever bypassed. Only "stats saw more than the log" is a
    gap, because ON CONFLICT legitimately fires a BEFORE INSERT trigger for a row that is not inserted.
    """
    logged: dict[tuple[str, str], int] = {}
    for c in changes:
        logged[(c["table"], c["op"])] = logged.get((c["table"], c["op"]), 0) + c["rows"]
    gaps = []
    for table, row in counts.items():
        for key, op in (("ins", "INSERT"), ("upd", "UPDATE"), ("del", "DELETE")):
            if row.get(key, 0) > logged.get((table, op), 0):
                gaps.append({"table": table, "op": op, "postgres_counted": row[key], "log_has": logged.get((table, op), 0)})
    return gaps


def unlogged_changes(cur, changes: list[dict]) -> list[dict]:
    """Tables whose rows changed with no row trigger firing, such as ALTER COLUMN TYPE ... USING.

    Row counts and statistics are both blind to a table rewrite, so this compares content against the
    hash taken when the golden clone was prepared, over the columns that existed then. That way adding
    a column does not count as changing the rows.
    """
    try:
        with open(CONTENT_BEFORE) as f:
            before = json.load(f)
    except OSError:
        return [{"table": "(all)", "detail": "no content baseline in this clone"}]
    logged = {c["table"] for c in changes}
    current = {t for t in txrun.table_columns(cur)}
    columns = {}
    kept = txrun.table_columns(cur)
    for table, cols in before["columns"].items():
        if table not in current or table in logged:
            continue
        names = {c for c, _ in kept[table]}
        columns[table] = [c for c in cols if c[0] in names]
    now = txrun.content_hashes(cur, columns)
    out = []
    for table in columns:
        if len(columns[table]) == len(before["columns"][table]):
            if now[table] != before["hashes"].get(table):
                out.append({"table": table, "detail": "rows changed with no row-level record, as in a table rewrite"})
        else:
            # Some columns were dropped, so the stored whole-row hash cannot be compared.
            out.append({"table": table, "detail": "a column was removed, so this table's content could not be compared"})
    return out


def collect(cur, before_counts: dict, before_schema: list, committed: bool, counts: dict) -> dict:
    cur.execute(
        """SELECT step, tbl, op, CASE WHEN depth <= 1 THEN 'direct' ELSE 'cascade' END AS via,
                  sum(n)::bigint
           FROM shadow.changes GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4"""
    )
    changes = [dict(zip(("step", "table", "op", "via", "rows"), r)) for r in cur.fetchall()]

    samples: dict = {}
    cur.execute(
        """SELECT tbl, op, old_row, new_row FROM (
             SELECT tbl, op, old_row, new_row,
                    row_number() OVER (PARTITION BY tbl, op ORDER BY seq) AS rn
             FROM shadow.changes WHERE op <> 'TRUNCATE') s
           WHERE rn <= %s ORDER BY tbl, op, rn""",
        (MAX_SAMPLES,),
    )
    for tbl, op, old, new in cur.fetchall():
        samples.setdefault(tbl, {}).setdefault(op, []).append({"before": old, "after": new})

    cur.execute("SELECT step, tag, object_type, identity FROM shadow.ddl ORDER BY seq")
    ddl = [dict(zip(("step", "tag", "object_type", "identity"), r)) for r in cur.fetchall()]

    after_counts = txrun.table_counts(cur)
    after_schema = txrun.schema_state(cur)
    unlogged = unlogged_changes(cur, changes) if ddl else []
    columns_after = txrun.table_columns(cur)
    touched = sorted({c["table"] for c in changes} | {t for t in before_counts if before_counts[t] != after_counts.get(t)} | {u["table"] for u in unlogged if u["table"] != "(all)"} | set(ddl_tables(ddl, set(before_counts) | set(after_counts))))
    measured = {t: columns_after.get(t, []) for t in touched}
    content_after = txrun.content_hashes(cur, measured)
    a, b = {tuple(r[:2]): r[2] for r in after_schema}, {tuple(r[:2]): r[2] for r in before_schema}
    schema_diff = [
        {"kind": k[0], "name": k[1], "change": "added" if k not in b else "removed" if k not in a else "changed"}
        for k in sorted(set(a) | set(b))
        if a.get(k) != b.get(k)
    ]
    return {
        "capture_gaps": capture_gaps(changes, counts),
        "changes": changes,
        "samples": samples,
        "ddl": ddl,
        "table_rows_before": before_counts,
        "table_rows_after": after_counts,
        "schema_diff": schema_diff,
        "schema_fingerprint_after": txrun.sha256_json(after_schema),
        "foreign_keys": cascade_paths(cur),
        "touched_tables": touched,
        "content_after": content_after,
        "unlogged_changes": unlogged,
        "committed": committed,
    }


def op_probe(job: dict) -> dict:
    """Try to reach the outside from inside. Reads the reply: a TCP connect alone proves nothing,
    because a userspace network gateway can accept a connection only to deny it."""
    nics = sorted(n for n in os.listdir("/sys/class/net"))
    with open("/proc/net/route") as f:
        routes = max(0, len(f.readlines()) - 1)
    results = []
    for t in job.get("targets", []):
        item = {"label": t["label"], "host": t["host"], "port": t["port"]}
        try:
            with socket.create_connection((t["host"], t["port"]), timeout=float(job.get("timeout", 2))) as s:
                s.settimeout(1.5)
                try:
                    s.sendall(b"GET / HTTP/1.0\r\nHost: probe\r\n\r\n")
                    reply = s.recv(512)
                except OSError:
                    reply = b""
                text = reply.decode("utf-8", "replace")
                if "network_policy_denied" in text:
                    item.update(result="BLOCKED", how="denied by sandbox network policy")
                else:
                    item.update(result="REACHABLE", how=f"connected; reply {text[:80]!r}")
        except OSError as e:
            item.update(result="BLOCKED", how=(e.strerror or type(e).__name__))
        results.append(item)
    try:
        socket.getaddrinfo(job.get("dns_name", "api.vultrinference.com"), 443)
        dns = "RESOLVED"
    except OSError as e:
        dns = f"BLOCKED ({e.strerror or type(e).__name__})"
    return {
        "ok": all(r["result"] == "BLOCKED" for r in results) and dns.startswith("BLOCKED"),
        "nics": nics,
        "routes": routes,
        "targets": results,
        "dns": dns,
    }


SCAN_ROOTS = ("/etc", "/home", "/root", "/tmp", "/var/tmp", "/opt", "/run", "/snap")
SCAN_SKIP = ("/opt/sr/guest", "/opt/sr/pgdata")


def op_secret_scan(job: dict) -> dict:
    """Look for credentials in every process environment and in the writable parts of the guest."""
    pattern = re.compile("|".join(job["patterns"]).encode())
    hits: list[dict] = []
    scanned = 0
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/environ", "rb") as f:
                data = f.read()
        except OSError:
            continue
        scanned += 1
        for m in pattern.finditer(data):
            hits.append({"where": f"/proc/{pid}/environ", "match": m.group(0)[:24].decode("utf-8", "replace")})
    for root in SCAN_ROOTS:
        for dirpath, dirnames, filenames in os.walk(root):
            if dirpath.startswith(SCAN_SKIP):
                dirnames[:] = []
                continue
            for name in filenames:
                path = os.path.join(dirpath, name)
                try:
                    if not os.path.isfile(path) or os.path.getsize(path) > 2_000_000:
                        continue
                    with open(path, "rb") as f:
                        data = f.read()
                except OSError:
                    continue
                scanned += 1
                for m in pattern.finditer(data):
                    hits.append({"where": path, "match": m.group(0)[:24].decode("utf-8", "replace")})
    return {"ok": not hits, "scanned": scanned, "hits": hits[:20]}


def main() -> int:
    job = json.load(sys.stdin)
    op = job["op"]
    handlers = {
        "prepare": op_prepare,
        "seal": op_seal,
        "inspect": op_inspect,
        "query": op_query,
        "suspects": op_suspects,
        "rehearse": op_rehearse,
        "probe": op_probe,
        "secret_scan": op_secret_scan,
    }
    try:
        result = handlers[op](job)
    except Exception as e:  # report failure as data; the host decides what it means
        result = {"ok": False, "fatal": True, "error": " ".join(str(e).split())[:1000], "type": type(e).__name__}
    json.dump(result, sys.stdout, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
