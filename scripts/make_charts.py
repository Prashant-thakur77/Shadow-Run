#!/usr/bin/env python3
"""The README's charts, drawn from the benchmark files and nothing else.

    python scripts/make_charts.py          -> docs/img/chart-*-{light,dark}.svg
    python scripts/make_charts.py --check  -> exit 1 if a committed chart differs from what the files give

Plain SVG with no scripts, so GitHub shows it as an image. Each chart comes in a light and a dark version for the
README's <picture> tags, and every bar is labelled with its value, so no number depends on colour. The tables in the
README hold the same numbers.
"""
from __future__ import annotations

import json
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / "bench"
OUT = ROOT / "docs" / "img"

FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif"
# GitHub's own surfaces and text, so the charts sit in the page. One accent for Shadow Run, a neutral for the baselines.
THEMES = {
    "light": dict(bg="#f6f8fa", border="#d0d7de", ink="#1f2328", ink2="#59636e", ink3="#6e7781", grid="#d8dee4", base="#8f8e88", accent="#2a78d6"),
    "dark": dict(bg="#161b22", border="#30363d", ink="#e6edf3", ink2="#9198a1", ink3="#7d8590", grid="#30363d", base="#6b6a65", accent="#3987e5"),
}


def load(name: str) -> dict:
    return json.loads((BENCH / name).read_text())


def fmt(x: float) -> str:
    return f"{x:g}"


def text(x: float, y: float, s: str, t: dict, size: int = 14, weight: int = 400, fill: str = "ink", anchor: str = "start") -> str:
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" font-weight="{weight}" fill="{t[fill]}" text-anchor="{anchor}" '
            f'style="font-variant-numeric: tabular-nums">{escape(s)}</text>')


def bar(x: float, y: float, w: float, h: float, color: str) -> str:
    """A bar anchored square to its baseline, with 4 px rounded data end."""
    if w < 4:
        return f'<rect x="{x:.1f}" y="{y:.1f}" width="3" height="{h:.1f}" fill="{color}"/>'
    r = 4
    return (f'<path d="M{x:.1f},{y:.1f} H{x + w - r:.1f} Q{x + w:.1f},{y:.1f} {x + w:.1f},{y + r:.1f} V{y + h - r:.1f} '
            f'Q{x + w:.1f},{y + h:.1f} {x + w - r:.1f},{y + h:.1f} H{x:.1f} Z" fill="{color}"/>')


def frame(w: int, h: int, t: dict, body: list[str], title: str) -> str:
    return "\n".join([
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-label="{escape(title)}" font-family="{escape(FONT)}">',
        f"<title>{escape(title)}</title>",
        f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="8" fill="{t["bg"]}" stroke="{t["border"]}"/>',
        *body,
        "</svg>",
        "",
    ])


def harm(t: dict) -> tuple[str, str]:
    """Harm on prod by mode, for the held-out tasks and the outside benchmark, on one shared scale."""
    st = load("stats.json")["main"]["sets"]
    res = load("results.json")
    W, X0, X1, top = 960, 352, 790, 112
    vmax = max(st[k]["arms"][a]["harm"] for k in ("heldout", "external") for a in ("direct", "static_gate", "unread"))
    scale = 12 if vmax <= 12 else (int(vmax) // 4 + 1) * 4
    px = lambda v: X0 + (X1 - X0) * v / scale
    body = [text(32, 44, "Harm on prod, by how the agent's plan reached it", t, 22, 600),
            text(32, 70, f"Same agent ({res['model']} on Vultr Serverless Inference), same prompt, a fresh copy of the database for every run, mean of {res['runs_per_task']} runs per task", t, 13, 400, "ink2")]
    y = top
    panels = (("heldout", f"{st['heldout']['arms']['direct']['tasks']} held-out risky tasks, ours"),
              ("external", f"{st['external']['arms']['direct']['tasks']} risky tasks adapted from an outside benchmark (SABER)"))
    for key, label in panels:
        arms = st[key]["arms"]
        c = st[key]["compare"]["unread_vs_direct"]["harm"]
        person = res[key]["shadow_run"]["harm_on_prod"]["mean"]
        body.append(text(32, y, label, t, 15, 600))
        body.append(text(W - 32, y, f"approved unread vs alone: {fmt(c['difference']).replace('-', '\u2212')} tasks, {c['tasks_down']} better, {c['tasks_up']} worse, p = {fmt(c['permutation_p'])}", t, 13, 400, "ink2", "end"))
        y += 16
        rows = (("Agent alone, straight to prod", arms["direct"]["harm"], "base"),
                ("Rule gate, retries, no person", arms["static_gate"]["harm"], "base"),
                ("Shadow Run, every plan approved unread", arms["unread"]["harm"], "accent"),
                ("Shadow Run, risky plans held for a person", person, "accent"))
        y0 = y
        for name, v, tone in rows:
            body.append(text(X0 - 14, y + 16, name, t, 14, 600 if tone == "accent" else 400, "ink", "end"))
            body.append(bar(X0, y, px(v) - X0, 22, t[tone]))
            body.append(text(max(px(v), X0 + 3) + 8, y + 16, fmt(v), t, 14, 700))
            y += 32
        body.append(f'<line x1="{X0}" y1="{y0 - 4}" x2="{X0}" y2="{y - 6}" stroke="{t["ink3"]}" stroke-width="1"/>')
        y += 30
    # one shared axis under both panels
    y -= 14
    for v in range(0, scale + 1, 4 if scale > 8 else 2):
        body.append(f'<line x1="{px(v):.1f}" y1="{top + 8}" x2="{px(v):.1f}" y2="{y - 18}" stroke="{t["grid"]}" stroke-width="1" stroke-dasharray="2 4"/>')
        body.append(text(px(v), y, fmt(v), t, 12, 400, "ink3", "middle"))
    body.append(text(X1 + 14, y, "tasks with harm", t, 12, 400, "ink3"))
    H = y + 40
    body.append(text(32, H - 18, "bench/results.json, bench/stats.json · the 0 rows are by design: risky plans wait for a person · tasks compared one by one, permutation test · scripts/make_charts.py", t, 12, 400, "ink3"))
    # the grid goes under the bars
    grid = [b for b in body if "stroke-dasharray" in b]
    rest = [b for b in body if "stroke-dasharray" not in b]
    return frame(W, H, t, grid + rest, "Harm on prod, by how the agent's plan reached it"), "harm"


def finding(t: dict) -> tuple[str, str]:
    """Harm before and after the two changes the evasion finding led to, task by task, approved unread."""
    aft = load("evasion.json")["after"]
    W, X0, X1 = 960, 352, 790
    panels = [("external", "Tasks adapted from an outside benchmark"), ("heldout", "Held-out tasks, ours")]
    vmax = max(aft[k]["harm"]["from"] for k, _ in panels)
    scale = max(4, int(vmax) + 2 - int(vmax) % 2)
    px = lambda v: X0 + (X1 - X0) * v / scale
    body = [text(32, 44, "What the finding changed: harm, task by task", t, 22, 600),
            text(32, 70, "Harm on prod, every plan approved unread, before and after the evasion checks and the empty-plan change. Mean of 3 runs per task", t, 13, 400, "ink2")]
    y = 108
    for key, label in panels:
        hm = aft[key]["harm"]
        body.append(text(32, y, f"{label} ({hm['tasks']})", t, 15, 600))
        body.append(text(W - 32, y, f"{fmt(hm['difference']).replace('-', '\u2212')} tasks, {hm['tasks_down']} better, {hm['tasks_up']} worse", t, 13, 400, "ink2", "end"))
        y += 16
        y0 = y
        for name, v, tone in (("Before the checks", hm["from"], "base"), ("With the checks", hm["to"], "accent")):
            body.append(text(X0 - 14, y + 16, name, t, 14, 600 if tone == "accent" else 400, "ink", "end"))
            body.append(bar(X0, y, px(v) - X0, 22, t[tone]))
            body.append(text(max(px(v), X0 + 3) + 8, y + 16, fmt(v), t, 14, 700))
            y += 32
        body.append(f'<line x1="{X0}" y1="{y0 - 4}" x2="{X0}" y2="{y - 6}" stroke="{t["ink3"]}" stroke-width="1"/>')
        y += 26
    H = y + 22
    body.append(text(32, H - 18, "bench/evasion.json (after) · tasks compared one by one · scripts/make_charts.py", t, 12, 400, "ink3"))
    return frame(W, H, t, body, "What the finding changed: harm, task by task"), "finding"

def wrap(s: str, n: int) -> list[str]:
    out, cur = [], ""
    for w in s.split():
        if cur and len(cur) + 1 + len(w) > n:
            out.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    return out + [cur] if cur else out


def numbers(t: dict) -> tuple[str, str]:
    """The measured counts, as tiles: containment on the left of the page's story, Vultr on the right."""
    rt, ctl, so, inc, vu = load("redteam.json"), load("controls.json"), load("soak.json"), load("incidents.json"), load("vultr.json")
    res = load("results.json")
    blocked = sum(1 for i in inc["incidents"] if i["status"] == "blocked" and not i.get("reached_prod"))
    contained_soak = so["rehearsals"] if so["all_contained"] and so["all_teardown_ok"] else 0
    tok = vu["inference"]["tokens"]
    rows = [
        ("Contained, checked from outside the sandbox", [
            (f"{rt['contained']} / {rt['total']}", "red-team attacks contained, prod's hash unchanged" if rt["prod_unchanged"] else "red-team attacks contained"),
            (f"{blocked} / {len(inc['incidents'])}", "real incidents replayed on a clone, all blocked" if blocked == len(inc["incidents"]) else "real incidents replayed on a clone and blocked"),
            (f"{ctl['passed']} / {ctl['total']}", "approval and apply attacks refused, honest path works"),
            (f"{contained_soak} / {so['rehearsals']}", "rehearsals in a row, every sandbox torn down"),
        ]),
        ("Measured on Vultr in the final benchmark", [
            (f"{vu['microvms']['total']:,}", "microVMs booted on a Vultr VX1"),
            (f"{vu['postgres']['benchmark']['databases_created']:,}", "databases created on Vultr Managed PostgreSQL"),
            (f"{tok / 1e6:.2f} M", "tokens on Vultr Serverless Inference"),
            (f"{fmt(res['heldout']['shadow_run']['rehearsal_s']['p50'])} s", "median rehearsal on a fresh clone, boot to teardown"),
        ]),
    ]
    W, pad, gap = 960, 32, 16
    tw = (W - 2 * pad - 3 * gap) / 4
    body = []
    y = 44
    for label, tiles in rows:
        body.append(text(pad, y, label, t, 15, 600))
        y += 14
        for i, (big, small) in enumerate(tiles):
            x = pad + i * (tw + gap)
            body.append(f'<rect x="{x:.1f}" y="{y}" width="{tw:.1f}" height="112" rx="6" fill="none" stroke="{t["border"]}"/>')
            body.append(text(x + 18, y + 46, big, t, 32, 700))
            for k, line in enumerate(wrap(small, 28)[:2]):
                body.append(text(x + 18, y + 74 + k * 18, line, t, 13, 400, "ink2"))
        y += 112 + 42
    H = y + 4
    body.append(text(pad, H - 18, "bench/redteam.json, controls.json, incidents.json, soak.json, vultr.json, results.json · drawn by scripts/make_charts.py", t, 12, 400, "ink3"))
    return frame(W, H, t, body, "Shadow Run by the numbers"), "numbers"


def build() -> dict[Path, str]:
    out = {}
    for mode, t in THEMES.items():
        for make in (harm, finding, numbers):
            svg, name = make(t)
            out[OUT / f"chart-{name}-{mode}.svg"] = svg
    return out


def main() -> int:
    files = build()
    if "--check" in sys.argv:
        stale = [p for p, s in files.items() if not p.exists() or p.read_text() != s]
        for p in stale:
            print(f"stale: {p.relative_to(ROOT)}")
        return 1 if stale else 0
    OUT.mkdir(parents=True, exist_ok=True)
    for p, s in files.items():
        p.write_text(s)
        print(f"wrote {p.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
