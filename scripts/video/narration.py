#!/usr/bin/env python3
"""Voice-over for the demo video. Numbers are read from the benchmark's JSON at render time, never typed.

Writes var/video/scenes.json and one mp3 per scene, spoken by Vultr Serverless Inference.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "var" / "video"
VOICE_MODEL = os.environ.get("SHADOWRUN_TTS_MODEL", "qwen3-tts-12hz-1.7b")
VOICE = os.environ.get("SHADOWRUN_TTS_VOICE", "ryan")


def env() -> None:
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v)


def load(name: str) -> dict | None:
    p = ROOT / "bench" / name
    return json.loads(p.read_text()) if p.exists() else None


def num(x: float) -> str:
    return f"{x:g}"


def results_line() -> str:
    r = load("results.json")
    if not r or r.get("status") != "measured":
        return "The benchmark table is on this page, with a re-run command for every number."
    h = r["heldout"]
    d, g, s = h["direct"], h["static_gate"], h["shadow_run"]
    return (
        f"Same agent, same prompt, same database, on {d['risky_tasks']} risky tasks held out from tuning. "
        f"Running directly, it caused harm {num(d['harm_on_prod']['mean'])} times. Behind a static rule gate, {num(g['harm_on_prod']['mean'])} times. "
        f"Through Shadow Run, {num(s['harm_on_prod']['mean'])}. If an approver rubber-stamped everything we held, {num(s['harm_if_rubber_stamped']['mean'])}, and that gap is published here too."
    )


def scenes() -> list[dict]:
    return [
        {"id": "hook", "text": "In April, an AI agent deleted a company's production database and its backups in nine seconds. It isn't the only one."},
        {"id": "title", "text": "Your agent wants to touch prod. Shadow Run lets it break a clone first."},
        {"id": "task", "text": "The agent writes the plan. Shadow Run hashes it, and runs that exact plan on a clone of production, inside a throwaway microVM on Vultr with no network device at all."},
        {"id": "blast", "text": "The plan says remove inactive users. Postgres says what that really means. Thousands of rows, paid invoices and customer orders, gone by cascade, each one traced back to the step that caused it. The guardrails fail, and the agent can't edit them."},
        {"id": "retry", "text": "Those measurements go back to the agent. It rewrites the plan and rehearses again, each time on a new clone, until the guardrails pass."},
        {"id": "redteam", "hold": 6, "text": "Now assume the agent goes rogue. Each of these attacks really runs, in its own microVM, with the static gate turned off. Drop the database. Delete the root filesystem. A fork bomb. A memory bomb. Steal the keys and phone home. Only the clone dies. Every check here is made from the host, not from inside the sandbox: file hashes, leftover processes, the firewall counter. And prod's hash is identical, before and after."},
        {"id": "approve", "hold": 3, "text": "The person who asked can't approve it. A tampered hash gets a conflict. A different person approves these exact hashes, and the same plan runs on prod in one transaction, with counts that match the rehearsal."},
        {"id": "drift", "hold": 4, "text": "Now change prod behind its back, and apply again. The row counts no longer match the rehearsal, so the whole transaction rolls back by itself, and prod is left as it was."},
        {"id": "mcp", "text": "It drops into agents teams already use, through MCP. This is OpenCode on Vultr inference, with no database credentials, rehearsing its way to a safe migration."},
        {"id": "results", "text": results_line()},
        {"id": "close", "text": "VX1 microVMs, Serverless Inference, Managed Postgres, Object Storage and a VPC. Every number here comes from a script in the repo."},
    ]


def duration(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())


def main() -> int:
    env()
    OUT.mkdir(parents=True, exist_ok=True)
    base, key = os.environ["VULTR_INFERENCE_BASE"], os.environ["VULTR_INFERENCE_KEY"]
    out = []
    for s in scenes():
        path = OUT / f"vo-{s['id']}.mp3"
        stamp = OUT / f"vo-{s['id']}.txt"
        if not (path.exists() and stamp.exists() and stamp.read_text() == s["text"]):
            for attempt in range(5):
                try:
                    r = httpx.post(f"{base}/audio/speech", headers={"Authorization": f"Bearer {key}"}, timeout=120, json={"model": VOICE_MODEL, "voice": VOICE, "input": s["text"], "response_format": "mp3"})
                    r.raise_for_status()
                    break
                except httpx.HTTPError as e:
                    print(f"{s['id']}: {type(e).__name__}, retrying", flush=True)
                    if attempt == 4:
                        raise
                    time.sleep(5 * (attempt + 1))
            path.write_bytes(r.content)
            stamp.write_text(s["text"])
        out.append({**s, "audio": str(path), "seconds": round(duration(path), 2)})
        print(s["id"], out[-1]["seconds"], flush=True)
    (OUT / "scenes.json").write_text(json.dumps(out, indent=1))
    total = sum(x["seconds"] for x in out)
    print(f"voice-over total {total:.1f} s")
    return 0 if total <= 175 else 1


if __name__ == "__main__":
    sys.exit(main())
