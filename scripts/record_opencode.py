#!/usr/bin/env python3
"""Run a real OpenCode session on Vultr inference through the live MCP server, and write it to docs/evidence/opencode-session.md.

The session is printed as it happened, apart from truncating long tool output. Bash, write and edit are off in docs/opencode.json,
so the only way the agent can reach the database is through Shadow Run. Re-run: python scripts/record_opencode.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from checker.controls import load_env, login  # noqa: E402

REQUEST = "Our users table has too many stale accounts. Run a migration on the demo-saas database that removes users who have not logged in for over a year."
MODEL = "vultr/qwen3.8-27b"


def clip(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit].rstrip() + " [cut]"


def tool_section(part: dict) -> list[str]:
    state = part.get("state") or {}
    name, status = part.get("tool", "tool"), state.get("status", "?")
    lines = [f"**Tool `{name}`** ({status})"]
    args = state.get("input") or {}
    steps = args.get("steps") or []
    statements = [s.get("cmd", "") for s in steps if isinstance(s, dict)] or args.get("queries") or []
    if statements:
        lines += ["```sql", *[clip(str(s), 400) for s in statements], "```"]
    raw = state.get("output") or ""
    try:
        out = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        out = None
    if isinstance(out, dict) and "status" in out:
        lines.append(f"Result: `{out.get('status')}`")
        if out.get("blocked_reason"):
            lines.append("Blocked: " + clip(str(out["blocked_reason"]), 300))
        lines += [f"- measured: {s}" for s in (out.get("blast_radius") or [])[:7]]
        failed = [g["name"] for g in out.get("guardrails") or [] if not g.get("passed")]
        if failed:
            lines.append("- guardrails failed: " + ", ".join(failed))
        if out.get("note"):
            lines.append("- " + clip(str(out["note"]), 200))
    return lines


def main() -> int:
    load_env()
    url = json.loads((ROOT / "infra/STATE.json").read_text())["public_url"]
    judge = login(url, "judge")
    judge.post("/api/demo/reset").raise_for_status()
    token = judge.headers["Authorization"].split()[1]
    env = {**os.environ, "SHADOWRUN_TOKEN": token, "OPENCODE_CONFIG": str(ROOT / "docs/opencode.json")}
    started = time.time()
    # An empty folder, so it can't read this repo or anything else to find a credential.
    with tempfile.TemporaryDirectory() as scratch:
        r = subprocess.run(["opencode", "run", "--pure", "-m", MODEL, "--format", "json", REQUEST], cwd=scratch, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=540)
    events = []
    for line in r.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    body: list[str] = []
    tools_seen = []
    for e in events:
        part = e.get("part") or {}
        if e.get("type") == "text" and part.get("text", "").strip():
            body += ["> " + clip(part["text"], 900).replace("\n", "\n> "), ""]
        elif e.get("type") == "tool_use" or part.get("type") == "tool":
            tools_seen.append(part.get("tool"))
            body += [*tool_section(part), ""]
    print("exit", r.returncode, "events", len(events), "tools", tools_seen, "seconds", round(time.time() - started), flush=True)
    if not tools_seen:
        print(r.stderr[-800:])
        return 1
    head = [
        "# OpenCode on Vultr inference, routed through Shadow Run", "",
        f"A real `opencode run` session against the live MCP server, unedited apart from truncation. Model `{MODEL}`. The agent has no database credentials, and bash, write and edit are disabled by [`docs/opencode.json`](../opencode.json). Recorded {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}. Re-run: `python scripts/record_opencode.py`.", "",
        f'Request: "{REQUEST}"', "",
    ]
    (ROOT / "docs/evidence/opencode-session.md").write_text("\n".join(head + body).rstrip() + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
