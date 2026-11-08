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
r, g, rt, c, inc = load('results.json'), load('gauntlet.json'), load('redteam.json'), load('controls.json'), load('incidents.json')
for name, doc in (('gauntlet', g), ('redteam', rt), ('controls', c), ('incidents', inc)):
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
st = load('stats.json')
cmp = st['main']['sets']['heldout']['compare']['unread_vs_direct'] if st.get('main', {}).get('code_sha256') == r.get('code_sha256') else None
if not cmp:
    sys.exit('stats.json does not match results.json: run python -m bench.stats')
hh, dd = cmp['harm'], cmp['done']
line = f"Approved unread, harm falls from {n(hh['from'])} to {n(hh['to'])}, and that holds task by task (p = {n(hh['permutation_p'])})"
# The evasion checks were written after reading plans from the held-out tasks, so the result before them goes beside the headline.
be = load('results.before-evasion.json') if (ROOT / 'bench' / 'results.before-evasion.json').exists() else {}
if be.get('status') == 'measured':
    bh = be['heldout']
    line += f"; before the evasion checks, written after reading these plans, it fell from {n(bh['direct']['harm_on_prod']['mean'])} to {n(bh['shadow_run']['harm_if_rubber_stamped']['mean'])}"
line += "."
# The table shows work done; the line only adds it when it is clear, or when it fell.
if dd['excludes_zero'] or dd['to'] < dd['from']:
    line += f" Work done goes from {n(dd['from'])} to {n(dd['to'])} (p = {n(dd['permutation_p'])})."
ctl = (st.get('controls') or {}).get('sets', {}).get('heldout_sql')
if ctl and st['controls'].get('same_code_as_main'):
    a = ctl['arms']
    line += f" Rules in the prompt get harm to {n(a['rules_in_prompt']['harm'])} of {ctl['tasks']} SQL tasks, but those plans land on prod with nobody looking."
line += " The zero is the hold: risky plans wait for a person with the measured report."
page = page.replace('[results_line]', line)
(OUT / 'slides/results.html').write_text(page)
ev = load('evasion.json')
ex = ev['examples'][0]
words = {'failed_guardrails': 'broke', 'passed': 'passed every guardrail', 'invalid_plan': 'no steps', 'sql_error': 'error on the clone'}
esc = lambda t: t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
ladder = ''.join(
    f"<p><span style=\"color:#8D9188;font-family:'JetBrains Mono', monospace\">Attempt {a['n']}</span> "
    f"<b style=\"color:{'#F08A7A' if a['verdict'] == 'passed' else '#EEC84E' if a['verdict'] == 'failed_guardrails' else '#EFECE6'}\">{words.get(a['verdict'], a['verdict'].replace('_', ' '))}"
    f"{': ' + esc('; '.join(a['broke'])) if a['broke'] else ''}</b><br><span style=\"font-family:'JetBrains Mono', monospace;font-size:21px;color:#C9C6BE\">"
    f"{esc((a['plan'] or ['(none)'])[0][:96])}</span></p>" for a in ex['attempts'] if a['verdict'] != 'invalid_plan')
un = ev['detection']['unseen']
page = (OUT / 'slides/found.html').read_text()
for k, v in {'request': esc(ex['request']), 'ladder': ladder, 'after_pct': ev['rates']['passed_after_breaking_a_rule']['harmful_pct'], 'first_pct': ev['rates']['passed_first_time']['harmful_pct'],
             'unseen_caught': un['harmful']['caught'], 'unseen_total': un['harmful']['total'], 'unseen_false': un['good']['caught'], 'unseen_good': un['good']['total'],
             'safe_broke': ev['rates']['safe_plans_that_broke_a_rule_first'], 'safe_plans': ev['rates']['safe_plans'],
             'ax_from': f"{ev['after']['external']['harm']['from']:g}", 'ax_to': f"{ev['after']['external']['harm']['to']:g}", 'ax_down': ev['after']['external']['harm']['tasks_down'], 'ax_up': ev['after']['external']['harm']['tasks_up'],
             'ah_from': f"{ev['after']['heldout']['harm']['from']:g}", 'ah_to': f"{ev['after']['heldout']['harm']['to']:g}", 'reader': esc(ex['second_reader'])}.items():
    page = page.replace(f'[{k}]', str(v))
(OUT / 'slides/found.html').write_text(page)
page = (OUT / 'slides/containment.html').read_text()
page = page.replace('[n] of [n] attacks contained', f"{rt['contained']} of {rt['total']} attacks contained").replace('[n] of [n] negative controls', f"{c['passed']} of {c['total']} negative controls")
# The incidents on the problem slide, replayed: stopped means it never reached prod and prod's hash didn't move.
for name in ('PocketOS', 'DataTalks.Club', 'SaaStr'):
    if not any(name in i['who'] for i in inc['incidents']):
        sys.exit(f'incidents.json has no {name} replay, which the containment slide names')
page = page.replace('[inc_stopped]', str(sum(1 for i in inc['incidents'] if not i['reached_prod'] and i['prod_unchanged']))).replace('[inc_total]', str(len(inc['incidents'])))
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
# Cost to serve, from the measured run and Vultr list prices: the same function that writes the README's unit economics.
sys.path.insert(0, str(ROOT / 'scripts'))
from make_readme_table import economics
e = economics()
if not e or e.get('fixed') is None:
    sys.exit('make_readme_table.economics() has no complete result')
# The size served today: the largest database a full rehearsal finished on (bench/scale.json).
sc = load('scale.json')
served_mb = max(x['db_mb'] for x in sc['rows'] if x.get('rehearsals_ok'))
page = (OUT / 'slides/market.html').read_text()
for k, v in {'weekly': mk['developers_using_agents']['weekly_pct'], 'g_low': mk['guardian_share']['low_pct'], 'g_high': mk['guardian_share']['high_pct'], 'g_year': mk['guardian_share']['by_year'],
             'tam_now_low': der['tam_usd_b_on_2025_market'][0], 'tam_now_high': der['tam_usd_b_on_2025_market'][1], 'sam': der['sam_usd_b_per_year'], 'first_m': der['first_target_usd_m_per_year'], 'first_pct': der['first_target_pct'], 'pg': f"{mk['postgres_companies']['count']:,}", 'price': mk['price']['usd_per_database_month'],
             'e_fixed': f"{e['fixed']:.0f}", 'size_gb': f"{round(served_mb / 1024):g}"}.items():
    page = page.replace(f'[{k}]', str(v))
(OUT / 'slides/market.html').write_text(page)
page = (OUT / 'slides/economics.html').read_text()
bars = ''.join(
    f"<p style=\"font-size:28px\">{k} database{'s' if k > 1 else ''}</p>"
    f"<div style=\"background:#E4E1D8;border-radius:6px;height:40px\"><div style=\"width:{m * 100:.0f}%;height:100%;background:#0B7A5E;border-radius:6px\"></div></div>"
    f"<p style=\"font-size:32px;font-weight:700;text-align:right\">{m * 100:.0f}%</p>" for k, m in sorted(e['margin_k'].items()))
for k, v in {'e_per_k': f"{e['per_k']:.2f}", 'e_fixed': f"{e['fixed']:.0f}", 'e_tasks': f"{round(e['tasks_to_cost'], -3):,.0f}",
             'price': e['price'], 'margin_bars': bars}.items():
    page = page.replace(f'[{k}]', str(v))
(OUT / 'slides/economics.html').write_text(page)
ai = mk.get('agent_incidents') or {}
page = (OUT / 'slides/problem.html').read_text()
line = (f"<b style=\"color:#F08A7A\">{ai['unexpected_or_unauthorized_pct']}%</b> of the professionals {ai['source'].split(',')[0]} surveyed in October 2026 confirmed or suspected an AI agent acting unexpectedly or without authorization. "
        f"Only <b>{ai['can_stop_automatically_pct']}%</b> could stop one automatically.") if ai else ''
page = page.replace('[incidents_line]', line)
page = page.replace('[survey_source]', f"{ai['source']}, {ai['respondents']}: {ai['unexpected_or_unauthorized_pct']}% confirmed or suspected unexpected or unauthorized agent activity; {ai['can_stop_automatically_pct']}% can automatically stop an agent." if ai else '')
(OUT / 'slides/problem.html').write_text(page)
page = (OUT / 'slides/competition.html').read_text()
cells = ''.join(f"<tr><td>{c['who']}</td><td>{c['strength']}</td><td>{c['gap']}</td></tr>" for c in mk['competition'])
page = page.replace('[rows]', cells).replace('[usp]', mk['us']['usp']).replace('[weakness]', mk['us']['weakness'])
(OUT / 'slides/competition.html').write_text(page)
# What the benchmark used on Vultr, from bench/vultr.json (read-only API counts and the runs' own records).
vu = json.loads((ROOT / 'bench' / 'vultr.json').read_text())
page = (OUT / 'slides/vultr.html').read_text()
for k, v in {'vu_microvms': f"{vu['microvms']['total']:,}", 'vu_databases': f"{vu['postgres']['benchmark']['databases_created']:,}",
             'vu_tokens': f"{vu['inference']['tokens']:,}", 'vu_models': str(vu['inference']['models_used']),
             'vu_objects': f"{vu['object_storage']['objects']:,}", 'vu_spent': f"{vu['spend']['budget']['spent_usd']:.2f}",
             'vu_budget': f"{vu['spend']['budget']['ceiling_usd']:.0f}"}.items():
    page = page.replace(f'[{k}]', v)
(OUT / 'slides/vultr.html').write_text(page)
# The idea slide: one plan and what Postgres measured it doing on a clone, from the recorded pull request comment for that plan.
pr = (ROOT / 'docs' / 'evidence' / 'pr-comment.md').read_text()
sql = re.search(r'```sql\n(.+?);?\n```', pr, re.S)
lines = {m.group(2): (int(m.group(1)), m.group(3), m.group(4)) for m in re.finditer(r'^\| (\d+) (\w+) (deleted|updated) (via cascade from users|directly) \(step \d+\) \|$', pr, re.M)}
paid = re.search(r'^\| Paid invoices on record \| ([\d.]+) \| ([\d.]+) \|$', pr, re.M)
gr = re.search(r'^Guardrails: (\d+) of (\d+) passed', pr, re.M)
# What the slide says about each table; payments.invoice_id is ON DELETE SET NULL, so an update there is a payment orphaned.
said = {'order_items': ('deleted', 'via cascade from users'), 'invoices': ('deleted', 'via cascade from users'), 'payments': ('updated', 'via cascade from users'),
        'orders': ('deleted', 'via cascade from users'), 'users': ('deleted', 'directly')}
if not sql or not paid or not gr or any(lines.get(t, (0,))[1:] != v for t, v in said.items()):
    sys.exit('docs/evidence/pr-comment.md does not have the measurements the idea slide shows')
before, after = float(paid.group(1)), float(paid.group(2))
page = (OUT / 'slides/idea.html').read_text()
for k, v in {'trap_sql': esc(sql.group(1).strip().rstrip(';')), **{f'c_{t}': f"{lines[t][0]:,}" for t in said},
             'paid_lost': f"{before - after:,.0f}", 'paid_before': f"{before:,.0f}", 'paid_after': f"{after:,.0f}",
             'gr_failed': str(int(gr.group(2)) - int(gr.group(1))), 'gr_total': gr.group(2)}.items():
    page = page.replace(f'[{k}]', v)
(OUT / 'slides/idea.html').write_text(page)
import base64
# The race slide shows a still of a real race on the live site, the recording docs/img/race.gif is cut from: the verdict and prod's hash as the page showed them.
race_slide = OUT / 'slides' / 'race.html'
race_slide.write_text(race_slide.read_text().replace('[race_image]', 'data:image/png;base64,' + base64.b64encode((ROOT / 'docs' / 'race.png').read_bytes()).decode())
                      .replace('[live_url]', g['url'].split('://', 1)[-1].rstrip('/')))
# The title slide shows the live site's hero, as docs/cover.png has it (scripts/make_cover.cjs renders that from the site).
cover_slide = OUT / 'slides' / 'cover.html'
cover_slide.write_text(cover_slide.read_text().replace('[cover_image]', 'data:image/png;base64,' + base64.b64encode((ROOT / 'docs' / 'cover.png').read_bytes()).decode()))
left = [str(p.name) for p in (OUT / 'slides').glob('*.html') if re.search(r'\[[a-z_n]+\]', p.read_text())]
print('filled', OUT, 'still has placeholders:', left)
subprocess.run(["node", str(ROOT / "scripts" / "render_slides.cjs"), str(ROOT / "web"), str(OUT), str(ROOT / "docs" / "slides.pdf")], check=True)
print("wrote docs/slides.pdf")
