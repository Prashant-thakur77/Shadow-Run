#!/usr/bin/env python3
"""Check the README's headline claims yourself, from the raw files, in a few seconds and with no network.

    python scripts/verify.py

For each claim it recomputes the number from bench/*.json, checks the README states that same number, and prints where
it came from. Then it checks that the code which measured the benchmark is the code in this checkout. Exit 0 if every
check passes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bench import provenance  # noqa: E402


def load(name: str) -> dict:
    return json.loads((ROOT / "bench" / name).read_text())


def claims() -> list[tuple[str, str, str]]:
    """(what the README says, the exact text it must contain, the file and field it comes from)."""
    r, st, rt, inc, cl, ev, so, vu = (load(n) for n in ("results.json", "stats.json", "redteam.json", "incidents.json", "controls.json", "evasion.json", "soak.json", "vultr.json"))
    h = st["main"]["sets"]["heldout"]
    d, u = h["arms"]["direct"], h["arms"]["unread"]
    c = h["compare"]["unread_vs_direct"]["harm"]
    ext = st["main"]["sets"]["external"]["compare"]["unread_vs_direct"]["harm"]
    held = r["heldout"]["shadow_run"]
    a, f = ev["rates"]["passed_after_breaking_a_rule"], ev["rates"]["passed_first_time"]
    blocked = sum(1 for i in inc["incidents"] if i["status"] == "blocked" and not i.get("reached_prod"))
    return [
        ("Held-out harm, approved unread", f"harm fell from {d['harm']:g} to {u['harm']:g} of {h['tasks']} held-out risky tasks", "stats.json main.sets.heldout.arms"),
        ("...task by task", f"p = {c['permutation_p']:g}, {c['tasks_down']} tasks better, {c['tasks_up']} worse", "stats.json ...compare.unread_vs_direct.harm"),
        ("Nothing harmful reached prod unseen", f"{held['harm_on_prod']['mean']:g} of {h['tasks']}, against {d['harm']:g} for the agent alone", "results.json heldout.shadow_run.harm_on_prod"),
        ("Outside benchmark (SABER)", f"harm went from {ext['from']:g} to {ext['to']:g}", "stats.json main.sets.external"),
        ("Rehearsal time, median", f"takes {held['rehearsal_s']['p50']:g} s at the median", "results.json heldout.shadow_run.rehearsal_s.p50"),
        ("Guardrail evasion", f"harmful {a['harmful_pct']}% of the time, against {f['harmful_pct']}%", "evasion.json rates"),
        ("Live attacks contained", f"{rt['contained']} of {rt['total']} live attacks contained", "redteam.json contained, total"),
        ("Real incidents blocked", f"{blocked} of {len(inc['incidents'])} real incident commands", "incidents.json incidents[].status"),
        ("Approval and apply checks", f"{cl['passed']} of {cl['total']} checks", "controls.json passed, total"),
        ("Soak test", f"{so['rehearsals']} rehearsals in {so['wall_s']:g} s", "soak.json rehearsals, wall_s"),
        ("microVMs on the VX1", f"{vu['microvms']['total']:,} microVMs", "vultr.json microvms.total"),
        ("Serverless Inference tokens", f"{vu['inference']['tokens']:,} tokens", "vultr.json inference.tokens"),
        ("Managed PostgreSQL databases", f"{vu['postgres']['benchmark']['databases_created']:,} throwaway databases", "vultr.json postgres.benchmark.databases_created"),
    ]


def main() -> int:
    readme = (ROOT / "README.md").read_text()
    rows, failed = [], 0
    for what, text, source in claims():
        ok = text in readme
        failed += not ok
        rows.append(("ok  " if ok else "FAIL", what, text, source))
    r = load("results.json")
    recorded = r.get("code_sha256", "")
    current = provenance.code_sha256(provenance.code_manifest())
    same = bool(recorded) and recorded == current
    failed += not same
    rows.append(("ok  " if same else "FAIL", "Code that measured = this checkout", f"sha256 {current[:12]}", f"results.json code_sha256 {recorded[:12]}"))
    w = max(len(x[1]) for x in rows)
    for status, what, text, source in rows:
        print(f"{status}  {what:<{w}}  {text}  [{source}]")
    print(f"\n{len(rows) - failed} of {len(rows)} checks pass." + ("" if not failed else " A failing claim means the README and the files disagree."))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
