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
        f"On {d['risky_tasks']} held-out risky tasks, the same agent alone caused harm about {round(d['harm_on_prod']['mean'])} times. "
        f"Through Shadow Run, nothing harmful reached prod without a person. If that person approved every plan unread, about {round(s['harm_if_rubber_stamped']['mean'])}, because the agent had seen the damage and rewritten its plans."
    )


def money(x: float) -> str:
    return f"{x / 1e6:.1f} million dollars" if x >= 1e6 else f"{x:,.0f} dollars"


def incident_line() -> str:
    inc = load("incidents.json")
    row = next((i for i in (inc or {}).get("incidents", []) if i["id"] == "saastr_freeze"), None)
    paid = next((m for m in (row or {}).get("metrics", []) if m["name"].startswith("Paid invoices")), None)
    if not paid:
        return "These are the commands behind real incidents, replayed on a clone, measured even when they're refused."
    return (
        f"These are the commands behind real incidents, replayed on a clone. The SaaStr wipe takes this demo's paid invoices from {money(paid['before'])} to {money(paid['after']) if paid['after'] else 'zero'}. "
        "Blocked, and prod never moved."
    )


def reach_words(columns: list[str]) -> str:
    if not columns:
        return "nothing"
    tables = sorted({c.split(".")[0] for c in columns})
    if len(columns) == 1:
        return f"one column, {columns[0].replace('_', ' ').replace('.', ' ')}"
    return f"{len(columns)} columns across {len(tables)} tables"


def gauntlet_line() -> str:
    g = load("gauntlet.json")
    if not g or not g.get("baseline_summary"):
        return "An attacker model is told every guardrail and the rule for auto-apply, and whatever gets through is published here."
    base, now = g["baseline_summary"], g["first_summary"]
    return (
        f"We attacked this ourselves. A model told every guardrail and the auto-apply rule got {num(base['would_auto_apply'])} of {num(base['real_attacks'])} damaging plans past a row limit, "
        f"with nobody looking, reaching {reach_words(base['reach_alone'])}. So auto-apply now works from a named list, and the same attacker can reach {reach_words(now['reach_alone'])}."
    )


def scenes() -> list[dict]:
    return [
        {"id": "hook", "text": "In April, an AI agent deleted a company's production database and its backups in nine seconds. It isn't the only one."},
        {"id": "title", "text": "Your agent wants to touch prod. Shadow Run lets it break a clone first."},
        {"id": "task", "text": "The agent writes the plan. Shadow Run hashes it and runs that exact plan on a clone of production, in a throwaway microVM on Vultr with no network device."},
        {"id": "blast", "text": "The plan says remove inactive users. Postgres says what that really means. Thousands of rows, paid invoices and customer orders, gone by cascade, each one traced back to the step that caused it. The guardrails fail, and the agent can't edit them."},
        {"id": "retry", "text": "Those measurements go back to the agent, which rewrites the plan and rehearses again on a new clone."},
        {"id": "redteam", "hold": 6, "text": "Now assume the agent goes rogue. These attacks really run, with the static gate off. Drop the database. Delete the root filesystem. A fork bomb. A memory bomb. Steal the keys and phone home. Only the clone dies. Every check is made from the host, and prod's hash is identical."},
        {"id": "approve", "hold": 3, "text": "The person who asked can't approve it. A tampered hash gets a conflict. A different person approves these exact hashes, and the same plan runs on prod in one transaction, with counts that match the rehearsal."},
        {"id": "drift", "hold": 5, "text": "Now change prod behind its back, and apply. The rows no longer match the rehearsal, so the whole transaction rolls back, and prod is left as it was."},
        {"id": "undo", "hold": 5, "text": "Every plan also comes with an undo, proved on the clone before anyone approves. One button, the same pipeline, and prod's hash comes back exactly."},
        {"id": "incidents", "hold": 3, "text": incident_line()},
        {"id": "gauntlet", "text": gauntlet_line()},
        {"id": "mcp", "text": "It works with agents teams already use. This is OpenCode on Vultr inference, with no database credentials, rehearsing its way to a safer plan."},
        {"id": "results", "text": results_line()},
        {"id": "close", "text": "All of it runs on Vultr, and every number here comes from a script in the repo. Your agent wants to touch prod. Let it break a clone first."},
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
