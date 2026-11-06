// Dev-only. Loaded through a guarded dynamic import, so none of this reaches the production bundle.
// Usage: /runs/x?fixture=run-agent-retry
//   &cut=N       keep the first N timeline events and clear attempts, to see an in-progress run
//   fixture=signin           signed out
//   fixture=run-minimal      a run with nothing but an id and status
//   fixture=run-error        a run that errored with no attempts
//   fixture=run-hostile      hostile strings in every text field
//   fixture=redteam-partial&n=3   a red team still running, n attacks in
//   fixture=redteam-failed   a failed check, an uncontained attack and a changed prod
//   fixture=results-table    the results page with data

const files = import.meta.glob('../../fixtures/*.json');
const params = new URLSearchParams(location.search);
const name = params.get('fixture') ?? '';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function load(file: string): Promise<Any> {
  const loader = files[`../../fixtures/${file}.json`];
  if (!loader) return null;
  return structuredClone(((await loader()) as { default: unknown }).default);
}

const STATUS_AFTER: Record<string, string> = {
  snapshot_taken: 'snapshotting',
  injected_text_flagged: 'snapshotting',
  planning: 'planning',
  agent_reads: 'planning',
  plan_frozen: 'planning',
  static_gate: 'planning',
  rehearsal_started: 'rehearsing',
  rehearsal_finished: 'rehearsing',
  guardrails_checked: 'rehearsing',
  apply_started: 'applying',
  backup_written: 'applying',
};

const HOSTILE = `<img src=x onerror="document.body.dataset.pwned='1'"><script>document.body.dataset.pwned='1'</script>`;

function hostile(run: Any): Any {
  run.task = `${HOSTILE} Archive users`;
  run.error = HOSTILE;
  run.blocked_reason = HOSTILE;
  for (const f of run.data_flags ?? []) f.preview = `${HOSTILE} ${f.preview}`;
  for (const a of run.attempts ?? []) {
    if (a.explanation) a.explanation.text = HOSTILE;
    for (const s of a.plan?.steps ?? []) {
      s.cmd = `${s.cmd} -- ${HOSTILE}`;
      s.why = HOSTILE;
    }
  }
  const samples = run.final?.report?.samples ?? {};
  for (const table of Object.values<Any>(samples)) {
    for (const rows of Object.values<Any>(table)) {
      for (const r of rows) if (r.before) r.before.email = HOSTILE;
    }
  }
  return run;
}

async function runFixture(): Promise<Any> {
  if (name === 'run-minimal') return { id: 'rminimal', status: 'queued' };
  if (name === 'run-error') return { id: 'rerror', status: 'error', error: 'RunnerError: the runner did not answer', attempts: [], timeline: [] };
  if (name === 'run-hostile') return hostile(await load('run-blocked-cascade'));
  const run = await load(name.startsWith('run-') ? name : 'run-agent-retry');
  if (!run) return null;
  // The capture gap can't be produced on a healthy system, so it is added here to check how it looks.
  if (name === 'run-warnings' && run.final?.report) {
    run.final.report.capture_gaps = [{ table: 'users', op: 'DELETE', postgres_counted: 12, log_has: 0 }];
    const n = run.final_attempt;
    for (const a of run.attempts ?? []) if (a.n === n && a.report) a.report.capture_gaps = run.final.report.capture_gaps;
  }
  const cut = params.get('cut');
  if (cut) {
    const n = Number(cut);
    run.timeline = (run.timeline ?? []).slice(0, n);
    run.attempts = [];
    run.final = null;
    run.final_attempt = null;
    run.status = n === 0 ? 'queued' : (STATUS_AFTER[run.timeline[run.timeline.length - 1]?.type] ?? 'rehearsing');
    run.can = { approve: false, apply: false, rehearse_again: false };
    for (const k of ['plan_hash', 'report_hash', 'challenge', 'approval', 'apply', 'backup', 'evidence', 'evidence_url', 'prod_after', 'blocked_reason']) delete run[k];
  }
  return run;
}

async function redteamFixture(): Promise<Any[]> {
  const list = await load('redteam-list');
  const rt = list[0];
  if (name === 'redteam-partial') {
    const n = Number(params.get('n') ?? 3);
    rt.status = 'running';
    rt.attacks = rt.attacks.slice(0, n);
    for (const k of ['prod_after', 'prod_unchanged', 'contained', 'total', 'wall_two']) delete rt[k];
    if (n === 0) delete rt.prod_during;
  }
  if (name === 'redteam-failed') {
    rt.attacks[3].contained = false;
    rt.attacks[3].checks[1].ok = false;
    rt.attacks[3].sandbox_error = 'the sandbox did not exit before the time cap';
    rt.contained = 6;
    rt.prod_after = '0000000000000000000000000000000000000000000000000000000000000000';
    rt.prod_unchanged = false;
    rt.wall_two.contained = false;
    rt.wall_two.reached_outside = true;
    rt.wall_two.rejected_delta = 0;
  }
  if (name === 'redteam-none') return [];
  return list;
}

export async function resolveFixture(method: string, full: string): Promise<{ status: number; body: unknown }> {
  const path = full.split('?')[0];
  const ok = (body: unknown) => ({ status: 200, body });
  if (path === '/api/demo/enter') {
    const me = await load('me');
    return ok({ username: 'judge', name: me?.name, token: me?.token, others: { reviewer: me?.token } });
  }
  if (path === '/api/public') {
    if (name === 'landing-headline') {
      // Layout check only. This module is never in a production build.
      return ok({ open_demo: true, headline: { risky_tasks: 88, direct: 88, static_gate: 88, shadow_run: 0, rubber_stamp: 8, runs_per_task: 3, measured_at: '2026-01-01T00:00:00Z' }, video_url: 'https://example.test/video', repo: 'https://example.test/repo' });
    }
    return ok((await load('public')) ?? { open_demo: true, headline: null });
  }
  if (path === '/api/incidents') return ok((await load('incidents')) ?? []);
  if (path === '/api/receipts') {
    if (name === 'receipts-empty') return ok({ items: [], note: "Nothing here is estimated. A claim with no measurement isn't listed." });
    return ok((await load('receipts')) ?? { items: [], note: '' });
  }
  if (path === '/api/gauntlet') {
    const list = (await load('gauntlet-list')) ?? [];
    if (name === 'gauntlet-running' && list[0]) {
      list[0].status = 'running';
      list[0].rounds = list[0].rounds.slice(0, 2);
      delete list[0].summary;
    }
    if (name === 'gauntlet-held' && list[0]) {
      list[0].rounds[0].would_auto_apply = false;
      list[0].rounds[0].held_because = ['10483 rows changed; budget is 100', 'static gate verdict is review'];
      list[0].rounds[1].would_auto_apply = true;
      list[0].rounds[1].held_because = [];
      list[0].rounds[3] = { ...list[0].rounds[3], outcome: 'caught_by_guardrail', caught_by: ['No payment loses its invoice', 'Paid invoices stay paid'], candidate: undefined };
    }
    if (name === 'gauntlet-none') return ok([]);
    return ok(list);
  }
  if (path === '/api/login' || path === '/api/logout') {
    const me = await load('me');
    return ok({ username: 'judge', name: me?.name, token: me?.token });
  }
  if (method !== 'GET') return { status: 503, body: { detail: 'Fixture mode: nothing was sent.' } };

  if (path === '/api/me') {
    if (name === 'signin' || params.get('signedout')) return { status: 401, body: { detail: 'not signed in' } };
    const me = await load('me');
    if (name.includes('as-reviewer') || params.get('as') === 'reviewer') {
      return ok({ ...me, username: 'reviewer', name: 'Reviewer (approver)', role: 'approver' });
    }
    return ok(me);
  }
  if (path === '/api/health') return ok(await load('health'));
  if (path === '/api/prod-checksum') return ok(await load('prod-checksum'));
  if (path === '/api/runs') return ok(await load('runs-list'));
  if (path.endsWith('/undo') && path.startsWith('/api/runs/')) {
    return ok({ statements: ['INSERT INTO users (id, email) VALUES (1, \'fixture\') ON CONFLICT DO NOTHING;'.repeat(40)] });
  }
  if (path.startsWith('/api/runs/')) {
    const run = await runFixture();
    return run ? ok(run) : { status: 404, body: { detail: 'no such run' } };
  }
  if (path === '/api/redteam/attacks') return ok(await load('redteam-attacks'));
  if (path === '/api/redteam') return ok(await redteamFixture());
  if (path === '/api/targets') return ok(await load('targets-all'));
  if (path.endsWith('/inspect')) return ok(await load('inspect'));
  if (path === '/api/audit') return ok((await load('audit')) ?? { events: [], chain: { ok: true, events: 0, head: '' } });
  if (path === '/api/results') {
    if (name === 'results-table') {
      // The shape bench/run.py writes, with placeholder values, for checking the layout in dev.
      return ok({
        status: 'measured', scope: 'full', at: '2026-01-01T00:00:00Z', model: 'fixture-model', runs_per_task: 3, runs: 800, harness_errors: 0, git_commit: 'abcdef0', rerun: 'python bench/run.py',
        table: {
          columns: ['Metric', 'Agent directly', 'Static gate only', 'Shadow Run'],
          rows: [
            ['Harmful outcomes on prod (of 88 risky, held-out)', '88 (88-88)', '88 (88-88)', '0 (0-0)'],
            ['...and if the approver rubber-stamps everything held', 'n/a', 'n/a', '8 (8-8)'],
            ['Safe tasks wrongly blocked (of 8)', '0 by definition', '8 (8-8)', '0 (0-0)'],
            ['Rehearsal time per attempt, p50 / p95 (s)', 'n/a', '~0', '8.8 / 8.8'],
          ],
        },
      });
    }
    return ok({ status: 'not measured yet' });
  }
  return { status: 404, body: { detail: `No fixture for ${path}` } };
}
