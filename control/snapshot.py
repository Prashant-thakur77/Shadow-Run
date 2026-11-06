"""Snapshot of a prod Postgres target. Checksums and dump come from one exported snapshot, so they agree.

The snapshot id is a hash of the data, so an unchanged prod reuses its golden clone.
"""
from __future__ import annotations

import os
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import psycopg

from control import settings
from control.plan import sha256_hex
from runner.guest import txrun


@dataclass
class ProdConn:
    host: str
    port: str
    user: str
    password: str
    dbname: str
    sslmode: str = "require"

    def kwargs(self) -> dict:
        return {"host": self.host, "port": self.port, "user": self.user, "password": self.password, "dbname": self.dbname, "sslmode": self.sslmode}

    def libpq_env(self) -> dict:
        # The password travels by environment, never argv, so it does not show up in `ps`.
        return {
            "PGHOST": self.host, "PGPORT": str(self.port), "PGUSER": self.user, "PGPASSWORD": self.password,
            "PGDATABASE": self.dbname, "PGSSLMODE": self.sslmode,
        }


def conn_from_target(target: dict) -> ProdConn:
    c = target["connection"]
    env = c.get("password_env")
    password = os.environ.get(env, "") if env else c.get("password", "")
    return ProdConn(c["host"], str(c["port"]), c["user"], password, c["dbname"], c.get("sslmode", "require"))


def fingerprint(conn: ProdConn) -> dict:
    """Row counts + per-table hash + schema hash. Read-only."""
    with psycopg.connect(**conn.kwargs(), autocommit=True) as c:
        cur = c.cursor()
        cur.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        checks = txrun.table_checksums(cur)
        schema = txrun.sha256_json(txrun.schema_state(cur))
        cur.execute("SELECT pg_current_wal_lsn()::text")
        lsn = cur.fetchone()[0]
        cur.execute("COMMIT")
    return {"tables": checks, "schema_sha256": schema, "lsn": lsn, "digest": sha256_hex({"t": checks, "s": schema})}


def take_snapshot(conn: ProdConn, out_dir: Path | None = None) -> dict:
    """Hold one REPEATABLE READ snapshot open, checksum inside it, and pg_dump that same snapshot."""
    out_dir = Path(out_dir or settings.SNAP_DIR)
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    t0 = time.perf_counter()
    with psycopg.connect(**conn.kwargs(), autocommit=True) as c:
        cur = c.cursor()
        cur.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
        cur.execute("SELECT pg_export_snapshot(), pg_current_wal_lsn()::text, current_setting('server_version')")
        exported, lsn, version = cur.fetchone()
        checks = txrun.table_checksums(cur)
        schema = txrun.sha256_json(txrun.schema_state(cur))
        checksum_ms = round((time.perf_counter() - t0) * 1000, 1)
        digest = sha256_hex({"t": checks, "s": schema})
        snapshot_id = f"s{digest[:20]}"

        t1 = time.perf_counter()
        path = out_dir / f"{uuid.uuid4().hex}.dump"
        with open(path, "wb") as f:
            r = subprocess.run(
                ["pg_dump", "-Fc", "--no-owner", "--no-privileges", f"--snapshot={exported}"],
                stdout=f, stderr=subprocess.PIPE, env={**os.environ, **conn.libpq_env()}, text=True,
            )
        cur.execute("COMMIT")
    if r.returncode != 0:
        path.unlink(missing_ok=True)
        raise RuntimeError(f"pg_dump failed: {r.stderr[:500]}")
    return {
        "snapshot_id": snapshot_id,
        "dump_path": str(path),
        "bytes": path.stat().st_size,
        "lsn": lsn,
        "server_version": version,
        "tables": checks,
        "schema_sha256": schema,
        "digest": digest,
        "timing": {"checksum_ms": checksum_ms, "pg_dump_ms": round((time.perf_counter() - t1) * 1000, 1)},
        "taken_at": time.time(),
    }
