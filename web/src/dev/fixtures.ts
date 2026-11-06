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
  if (path === '/api/login' || path === '/api/logout') {
    const me = await load('me');
    return ok({ username: 'judge', name: me?.name, token: me?.token });
  }
  if (method !== 'GET') return { status: 503, body: { detail: 'Fixture mode: nothing was sent.' } };

  if (path === '/api/me') {
    if (name === 'signin') return { status: 401, body: { detail: 'not signed in' } };
    const me = await load('me');
    if (name.includes('as-reviewer') || params.get('as') === 'reviewer') {
      return ok({ ...me, username: 'reviewer', name: 'Reviewer (approver)', role: 'approver' });
    }
    return ok(me);
  }
  if (path === '/api/health') return ok(await load('health'));
  if (path === '/api/prod-checksum') return ok(await load('prod-checksum'));
  if (path === '/api/runs') return ok(await load('runs-list'));
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
      return ok({ table: { columns: ['example column', 'value'], rows: [['fixture row', 'dev only']] }, notes: 'Dev fixture to check the table layout.' });
    }
    return ok({ status: 'not measured yet' });
  }
  return { status: 404, body: { detail: `No fixture for ${path}` } };
}
