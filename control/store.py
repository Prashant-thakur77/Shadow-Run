"""Control-plane state in SQLite. Runs are JSON documents; the audit log is a hash chain."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from control import settings
from control.plan import canonical_json

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, created_at REAL NOT NULL, updated_at REAL NOT NULL, status TEXT NOT NULL,
  requester TEXT NOT NULL, target_id TEXT NOT NULL, doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at DESC);
CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts REAL NOT NULL, actor TEXT NOT NULL,
  type TEXT NOT NULL, detail TEXT NOT NULL, prev_sha256 TEXT NOT NULL, sha256 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, seq);
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, run_id TEXT NOT NULL, used_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS redteam (id TEXT PRIMARY KEY, created_at REAL NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""


class Store:
    def __init__(self, path: Path | str | None = None) -> None:
        self.path = str(path or settings.DB_PATH)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._db.commit()

    # ------------------------------------------------------------- runs

    def save_run(self, run: dict) -> None:
        run["updated_at"] = time.time()
        with self._lock:
            self._db.execute(
                """INSERT INTO runs (id, created_at, updated_at, status, requester, target_id, doc)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status, doc=excluded.doc""",
                (run["id"], run["created_at"], run["updated_at"], run["status"], run["requester"], run["target_id"], json.dumps(run, default=str)),
            )
            self._db.commit()

    def get_run(self, run_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT doc FROM runs WHERE id=?", (run_id,)).fetchone()
        return json.loads(row["doc"]) if row else None

    def list_runs(self, limit: int = 50) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT doc FROM runs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r["doc"]) for r in rows]

    def count_runs_since(self, requester: str, since: float) -> int:
        with self._lock:
            return self._db.execute("SELECT count(*) FROM runs WHERE requester=? AND created_at>=?", (requester, since)).fetchone()[0]

    def set_status_if(self, run_id: str, expected: str | tuple[str, ...], new: str) -> dict | None:
        """Compare-and-swap on status, so two approvals racing cannot both win."""
        allowed = (expected,) if isinstance(expected, str) else expected
        with self._lock:
            run = self.get_run(run_id)
            if run is None or run["status"] not in allowed:
                return None
            run["status"] = new
            self.save_run(run)
            return run

    # ------------------------------------------------------------- targets

    def save_target(self, target: dict) -> None:
        with self._lock:
            self._db.execute("INSERT INTO targets (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc", (target["id"], json.dumps(target)))
            self._db.commit()

    def get_target(self, target_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT doc FROM targets WHERE id=?", (target_id,)).fetchone()
        return json.loads(row["doc"]) if row else None

    def list_targets(self) -> list[dict]:
        with self._lock:
            return [json.loads(r["doc"]) for r in self._db.execute("SELECT doc FROM targets ORDER BY id").fetchall()]

    # ------------------------------------------------------------- hash-chained audit log

    def append_event(self, run_id: str | None, actor: str, type_: str, detail: dict | None = None) -> dict:
        """sha256(prev + canonical(body)). Pattern from Tieout's events.py."""
        detail = detail or {}
        ts = time.time()
        with self._lock:
            row = self._db.execute("SELECT sha256 FROM events ORDER BY seq DESC LIMIT 1").fetchone()
            prev = row["sha256"] if row else ""
            body = {"run_id": run_id, "ts": ts, "actor": actor, "type": type_, "detail": detail}
            digest = hashlib.sha256(prev.encode() + canonical_json(body)).hexdigest()
            cur = self._db.execute(
                "INSERT INTO events (run_id, ts, actor, type, detail, prev_sha256, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (run_id, ts, actor, type_, json.dumps(detail, default=str), prev, digest),
            )
            self._db.commit()
        return {"seq": cur.lastrowid, **body, "sha256": digest, "prev_sha256": prev}

    def events(self, run_id: str | None = None, after: int = 0, limit: int = 1000) -> list[dict]:
        q = "SELECT * FROM events WHERE seq>?"
        args: list[Any] = [after]
        if run_id:
            q += " AND run_id=?"
            args.append(run_id)
        with self._lock:
            rows = self._db.execute(q + " ORDER BY seq LIMIT ?", (*args, limit)).fetchall()
        return [{**dict(r), "detail": json.loads(r["detail"])} for r in rows]

    def verify_chain(self) -> dict:
        prev = ""
        count = 0
        with self._lock:
            rows = self._db.execute("SELECT * FROM events ORDER BY seq").fetchall()
        for r in rows:
            body = {"run_id": r["run_id"], "ts": r["ts"], "actor": r["actor"], "type": r["type"], "detail": json.loads(r["detail"])}
            digest = hashlib.sha256(prev.encode() + canonical_json(body)).hexdigest()
            if r["prev_sha256"] != prev or r["sha256"] != digest:
                return {"ok": False, "broken_at_seq": r["seq"], "events": count}
            prev = digest
            count += 1
        return {"ok": True, "events": count, "head": prev}

    # ------------------------------------------------------------- nonces

    def consume_nonce(self, nonce: str, run_id: str) -> bool:
        with self._lock:
            try:
                self._db.execute("INSERT INTO nonces (nonce, run_id, used_at) VALUES (?, ?, ?)", (nonce, run_id, time.time()))
                self._db.commit()
                return True
            except sqlite3.IntegrityError:
                return False

    # ------------------------------------------------------------- red team and misc

    def save_redteam(self, rid: str, doc: dict) -> None:
        with self._lock:
            self._db.execute("INSERT INTO redteam (id, created_at, doc) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc", (rid, doc.get("created_at", time.time()), json.dumps(doc, default=str)))
            self._db.commit()

    def list_redteam(self, limit: int = 10) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT doc FROM redteam ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [json.loads(r["doc"]) for r in rows]

    def kv_get(self, k: str) -> Any:
        with self._lock:
            row = self._db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return json.loads(row["v"]) if row else None

    def kv_set(self, k: str, v: Any) -> None:
        with self._lock:
            self._db.execute("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, json.dumps(v, default=str)))
            self._db.commit()
