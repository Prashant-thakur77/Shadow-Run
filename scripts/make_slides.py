#!/usr/bin/env python3
"""Fill the deck's placeholders from bench/*.json and docs/market.json, then render docs/slides.pdf. Refuses partial results.

The filled deck goes to var/deck-final. Usage: python scripts/make_slides.py [--local]
"""
import subprocess
import json, re, shutil, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
DECK = ROOT / 'docs' / 'deck' / 'project'
OUT = ROOT / 'var' / 'deck-final' / 'project'
local = '--local' in sys.argv
load = lambda n: json.loads((ROOT / 'bench' / n).read_text())
r, g, rt, c = load('results.json'), load('gauntlet.json'), load('redteam.json'), load('controls.json')
for name, doc in (('gauntlet', g), ('redteam', rt), ('controls', c)):
    if not str(doc.get('url', '')).startswith('https://') and not local:
        sys.exit(f'{name}.json was not measured on the live URL')
if r.get('status') != 'measured' or r.get('harness_errors') != 0:
    sys.exit('results.json is not a complete run')
if OUT.parent.exists():
    shutil.rmtree(OUT.parent)
shutil.copytree(DECK, OUT)
n = lambda x: f'{x:g}'
h, e = r['heldout'], r['external']
d, s, sr = h['direct'], h['static_gate'], h['shadow_run']
ed, es, er = e['direct'], e['static_gate'], e['shadow_run']
# Row by row, in the table's order: direct, static gate, Shadow Run.
rows = {
    'Did the job, no harm, held-out risky tasks (Shadow Run: approved unread)': [n(d['risky_done']['mean']), n(s['risky_done']['mean']), n(sr['risky_done_if_rubber_stamped']['mean'])],
    'Harm on prod, same runs': [n(d['harm_on_prod']['mean']), n(s['harm_on_prod']['mean']), n(sr['harm_if_rubber_stamped']['mean'])],
    'Harm on prod with no person, held-out risky tasks': [n(d['harm_on_prod']['mean']), n(s['harm_on_prod']['mean']), n(sr['harm_on_prod']['mean'])],
    'Harm on prod with no person, SABER-derived tasks': [n(ed['harm_on_prod']['mean']), n(es['harm_on_prod']['mean']), n(er['harm_on_prod']['mean'])],
    'Safe tasks wrongly blocked': ['0', n(s['safe_wrongly_blocked']['mean']), n(sr['safe_wrongly_blocked']['mean'])],
    'Rehearsal time, median': ['n/a', 'n/a', f"{sr['rehearsal_s']['p50']} s"],
    'Inference cost per task': [f"${d['cost_per_task_usd']}", f"${s['cost_per_task_usd']}", f"${sr['cost_per_task_usd']}"],
}
page = (OUT / 'slides/results.html').read_text()
for label, values in rows.items():
    m = re.search(r'<tr><td>' + re.escape(label) + r'</td>(.*?)</tr>', page)
    cells = [f'<td style="text-align:right">{v}</td>' for v in values]
    page = page.replace(m.group(0), f'<tr><td>{label}</td>{"".join(cells)}</tr>')
(OUT / 'slides/results.html').write_text(page)
page = (OUT / 'slides/containment.html').read_text()
page = page.replace('[n] of [n] attacks contained', f"{rt['contained']} of {rt['total']} attacks contained").replace('[n] of [n] negative controls', f"{c['passed']} of {c['total']} negative controls")
(OUT / 'slides/containment.html').write_text(page)
reach = lambda x: ', '.join(x.get('reach_alone', [])) or 'nothing'
base, now, after = g['baseline_summary'], g['first_summary'], g['summary']
page = (OUT / 'slides/attacked.html').read_text()
for k, v in {'base_real': base['real_attacks'], 'base_alone': base['would_auto_apply'], 'base_reach': reach(base), 'now_real': now['real_attacks'], 'now_alone': now['would_auto_apply'], 'now_reach': reach(now),
             'after_real': after['real_attacks'], 'after_alone': after['would_auto_apply'], 'after_reach': reach(after), 'replay_caught': g['replay']['caught'], 'replay_total': g['replay']['total']}.items():
    page = page.replace(f'[{k}]', str(v))
(OUT / 'slides/attacked.html').write_text(page)
mk = json.loads((ROOT / 'docs' / 'market.json').read_text())
der = mk['derived']
page = (OUT / 'slides/market.html').read_text()
for k, v in {'weekly': mk['developers_using_agents']['weekly_pct'], 'g_low': mk['guardian_share']['low_pct'], 'g_high': mk['guardian_share']['high_pct'], 'g_year': mk['guardian_share']['by_year'],
             'tam_now_low': der['tam_usd_b_on_2025_market'][0], 'tam_now_high': der['tam_usd_b_on_2025_market'][1], 'sam': der['sam_usd_b_per_year'], 'first_m': der['first_target_usd_m_per_year'], 'first_pct': der['first_target_pct'], 'pg': f"{mk['postgres_companies']['count']:,}", 'price': mk['price']['usd_per_database_month']}.items():
    page = page.replace(f'[{k}]', str(v))
(OUT / 'slides/market.html').write_text(page)
page = (OUT / 'slides/competition.html').read_text()
cells = ''.join(f"<tr><td>{c['who']}</td><td>{c['strength']}</td><td>{c['gap']}</td></tr>" for c in mk['competition'])
page = page.replace('[rows]', cells).replace('[usp]', mk['us']['usp']).replace('[weakness]', mk['us']['weakness'])
(OUT / 'slides/competition.html').write_text(page)
left = [str(p.name) for p in (OUT / 'slides').glob('*.html') if re.search(r'\[[a-z_n]+\]', p.read_text())]
print('filled', OUT, 'still has placeholders:', left)
subprocess.run(["node", str(ROOT / "scripts" / "render_slides.cjs"), str(ROOT / "web"), str(OUT), str(ROOT / "docs" / "slides.pdf")], check=True)
print("wrote docs/slides.pdf")
