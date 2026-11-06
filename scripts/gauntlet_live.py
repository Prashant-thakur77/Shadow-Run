#!/usr/bin/env python3
"""Let the attacker model try to get past the guardrails on the live system. Writes bench/gauntlet.json."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from checker.controls import load_env, login  # noqa: E402


def generation(judge, label: str, policy: str = "named_scope", rounds: int = 8) -> dict:
    doc = judge.post("/api/targets/demo-saas/gauntlet", json={"rounds": rounds, "policy": policy}, timeout=60).json()
    t0 = time.time()
    seen = 0
    while time.time() - t0 < 1800:
        time.sleep(4)
        doc = next(d for d in judge.get("/api/gauntlet?limit=5").json() if d["id"] == doc["id"])
        for r in doc["rounds"][seen:]:
            held = "WOULD AUTO-APPLY" if r.get("would_auto_apply") else "held for a person" if "would_auto_apply" in r else ""
            print(f"{label} round {r['n']}: {r['outcome']:20} {held:18} {str(r.get('idea'))[:80]}", flush=True)
            if r.get("caught_by"):
                print("   caught by:", ", ".join(r["caught_by"])[:120], flush=True)
            if r.get("candidate"):
                print("   candidate:", r["candidate"]["name"], "proved:", r["candidate"]["proof"]["proved"], flush=True)
            if r.get("detail"):
                print("   ", str(r["detail"])[:160], flush=True)
        seen = len(doc["rounds"])
        if doc["status"] != "running":
            break
    return doc


def adopt(judge, doc: dict) -> list[str]:
    names = []
    for r in doc["rounds"]:
        c = r.get("candidate")
        if c and c["proof"]["proved"]:
            judge.post(f"/api/guardrails/candidates/{c['id']}/accept").raise_for_status()
            names.append(c["name"])
    return names


def main() -> int:
    """The same attacker, told the rule in force each time. Old policy, then the policy in force, then replay what got past against what it taught."""
    load_env()
    url = os.environ.get("SHADOWRUN_URL") or json.loads((ROOT / "infra/STATE.json").read_text())["public_url"]
    judge = login(url, "judge")
    judge.post("/api/demo/reset").raise_for_status()
    before = len(judge.get("/api/targets/demo-saas").json()["guardrails"])
    baseline = generation(judge, "row budget", "row_budget_only")
    judge.post("/api/demo/reset").raise_for_status()
    first = generation(judge, "named list")
    adopted = adopt(judge, first)
    print("adopted:", adopted, flush=True)
    first = judge.post(f"/api/gauntlet/{first['id']}/replay", timeout=900).json()
    replay = first.get("replay") or {"total": 0, "caught": 0, "did_not_run": 0}
    print(f"replay: {replay['caught']} of {replay['total']} now stopped, {replay['did_not_run']} did not run", flush=True)
    second = generation(judge, "after learning")
    after = len(judge.get("/api/targets/demo-saas").json()["guardrails"])
    generations = [baseline, first, second]
    doc = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "url": url,
        "model": first.get("model"),
        "guardrails_before": before,
        "guardrails_after": after,
        "adopted": adopted,
        "baseline_summary": baseline.get("summary"),
        "first_summary": first.get("summary"),
        "summary": second.get("summary"),
        "replay": replay,
        "generations": generations,
        "cost_usd": round(sum(g.get("cost_usd") or 0 for g in generations), 5),
        "rerun": "python scripts/gauntlet_live.py",
    }
    (ROOT / "bench/gauntlet.json").write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: doc[k] for k in ("baseline_summary", "first_summary", "summary", "guardrails_before", "guardrails_after", "cost_usd")}))
    judge.post("/api/demo/reset").raise_for_status()
    return 0 if all(g["status"] == "done" for g in generations) else 1


if __name__ == "__main__":
    sys.exit(main())
