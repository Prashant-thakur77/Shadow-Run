import type { Attempt, PublicHero, Run, TimelineEvent } from '../api/types';
import { bytes, isNum, num, short } from '../lib/format';
import type { Tone } from '../lib/status';
import { isInProgress, verdictText, verdictTone } from '../lib/status';
import type { GanttAttempt, GanttBar, GanttStep } from '../ui/RunGantt';
import type { ProdView, RoomsLive } from '../ui/TwoRooms';
import { failedGuardrails, liveAttempts, snapshotEvent } from './derive';
import { beforeApplyHash } from './ProdProof';

const unusable = (hash?: string | null) => !hash || hash.startsWith('unavailable');
const usable = (hash?: string | null) => (unusable(hash) ? null : (hash as string));

export const isHostReport = (a: Attempt | null | undefined) => a?.report?.kind === 'host';

/** Dollars on the demo targets are records on a seeded database, not money anyone spent. */
export const isSeeded = (run: Run) => run.target_id?.startsWith('demo') ?? false;

/** Only what happened in this attempt, with the clock starting as its plan froze. Time spent planning is not part of a
 *  rehearsal, and leaving it in would make a replay sit idle for as long as the model took to think. */
function attemptTimeline(run: Run, attempt: Attempt): { type: string; t: number }[] {
  const events = run.timeline ?? [];
  const mine = events.filter((e) => e.detail?.attempt === attempt.n);
  const base = mine.find((e) => e.type === 'plan_frozen')?.t ?? mine.find((e) => e.type === 'rehearsal_started')?.t ?? mine[0]?.t ?? run.created_at ?? 0;
  const out = mine.filter((e) => isNum(e.t) && (e.t as number) >= base).map((e) => ({ type: e.type, t: (e.t as number) - base }));
  const prod = events.find((e) => e.type === 'prod_checked');
  if (prod && isNum(prod.t) && attempt.n === run.final_attempt) out.push({ type: 'prod_checked', t: prod.t - base });
  return out;
}

/** A wipe can list one entry per file, more than a room can label. The deepest fold into their parent until they fit. Counts are summed, never estimated. */
function foldPaths(dirs: { path: string; files?: number }[], most = 8): { path: string; files: number }[] {
  const depth = (path: string) => path.split('/').filter(Boolean).length;
  let list = dirs.map((d) => ({ path: d.path, files: d.files ?? 0 }));
  while (list.length > most) {
    const deepest = Math.max(...list.map((d) => depth(d.path)));
    if (deepest <= 1) break;
    const merged = new Map<string, number>();
    for (const d of list) {
      const path = depth(d.path) === deepest ? d.path.slice(0, d.path.lastIndexOf('/')) || '/' : d.path;
      merged.set(path, (merged.get(path) ?? 0) + d.files);
    }
    list = [...merged].map(([path, files]) => ({ path, files }));
  }
  return list;
}

/** A host report says which files went, by directory, and how many files the server has. Those are the blocks. */
function hostShape(run: Run, attempt: Attempt): Pick<PublicHero, 'snapshot_rows' | 'tables' | 'totals' | 'extras'> {
  const report = attempt.report ?? {};
  const t = report.totals ?? {};
  const listed = report.deleted_by_directory ?? [];
  const dirs = foldPaths(listed);
  const onServer = run.snapshot?.files;
  const deleted = dirs.reduce((sum, d) => sum + d.files, 0);
  const other = isNum(onServer) ? Math.max(0, onServer - deleted) : 0;
  const changed = t.files_changed ?? 0;
  const rows: Record<string, number> = {};
  for (const d of dirs) rows[d.path] = d.files;
  if (other > 0) rows['other files'] = other;
  const tables: PublicHero['tables'] = dirs.map((d) => ({ table: d.path, rows_before: d.files, rows_after: 0, deleted: d.files, updated: 0, cascade: 0 }));
  // Changed files survive with damage, so they're rings among the rest.
  if (changed > 0 && other > 0) tables.push({ table: 'other files', rows_before: other, rows_after: other, deleted: 0, updated: changed, cascade: 0 });
  const created = t.files_created ?? 0;
  return {
    snapshot_rows: rows,
    tables,
    totals: { rows_changed: (t.files_deleted ?? 0) + changed + created, rows_deleted: t.files_deleted, rows_via_cascade: 0, tables_touched: listed.length },
    extras: [
      { name: 'Services stopped', text: num(t.services_stopped) },
      { name: 'Space freed', text: bytes(t.bytes_freed) },
    ],
  };
}

/** The shape the hero and the run panel share, from a run. Null when the attempt has no measurement to draw. */
export function roomsFromRun(run: Run, attempt: Attempt | null): PublicHero | null {
  const report = attempt?.report;
  if (!attempt || !report) return null;
  const r = attempt.rehearsal ?? {};
  const phases = r.phases ?? {};
  const guardrails = attempt.guardrails ?? [];
  const base = {
    run_id: run.id,
    measured_at: run.created_at ?? null,
    incident: { who: run.incident?.who, when: run.incident?.when, source: run.incident?.source },
    command: (attempt.plan?.steps ?? []).slice(0, 4).map((s) => (s.cmd ?? '').slice(0, 240)).filter(Boolean),
    plan_hash: attempt.plan_hash,
    timeline: attemptTimeline(run, attempt),
    phases: {
      clone_boot_ms: phases.clone_boot_ms,
      first_exec_ms: phases.first_exec_ms,
      probe_ms: phases.probe_ms,
      execute_ms: phases.execute_ms,
      secret_scan_ms: phases.secret_scan_ms,
      destroy_ms: phases.destroy_ms,
      total_ms: phases.total_ms,
      systemd_boot_ms: phases.systemd_boot_ms,
      load_state_ms: phases.load_state_ms,
    },
    edges: (report.cascade_graph?.edges ?? []).map((e) => ({ from: e.from, to: e.to, on_delete: e.on_delete, rows: e.rows })),
    metrics: (report.metrics ?? []).map((m) => ({ id: m.id, name: m.name, unit: m.unit, before: m.before, after: m.after })),
    guardrails: { passed: guardrails.filter((g) => g.passed).length, total: guardrails.length },
    probes: (r.probes?.targets ?? []).map((p) => ({ label: p.label, result: p.result })),
    secret_scan: { scanned: r.secret_scan?.scanned, hits: r.secret_scan?.hits?.length },
    teardown: { sandbox_listed: r.teardown?.sandbox_listed, rootfs_exists: r.teardown?.rootfs_exists, leftover_processes: r.teardown?.leftover_processes },
    prod: { before: run.prod_check?.before, after: run.prod_check?.after, unchanged: run.prod_check?.unchanged, measured_from: run.prod_check?.measured_from },
  };
  if (report.kind === 'host') return { ...base, ...hostShape(run, attempt) };

  const tablesInSnapshot = Object.entries(run.snapshot?.tables ?? {});
  const snapshot_rows: Record<string, number> = tablesInSnapshot.length
    ? Object.fromEntries(tablesInSnapshot.map(([name, t]) => [name, t.rows ?? 0]))
    : Object.fromEntries((report.tables ?? []).filter((t) => (t.rows_before ?? 0) > 0).map((t) => [t.table, t.rows_before ?? 0]));
  return {
    ...base,
    snapshot_rows,
    tables: (report.tables ?? []).map((t) => ({
      table: t.table,
      rows_before: t.rows_before,
      rows_after: t.rows_after,
      deleted: t.deleted,
      updated: t.updated,
      inserted: t.inserted,
      cascade: t.cascade,
      pct_of_table: t.pct_of_table,
    })),
    totals: {
      rows_changed: report.totals?.rows_changed,
      rows_deleted: report.totals?.rows_deleted,
      rows_via_cascade: report.totals?.rows_via_cascade,
      tables_touched: report.totals?.tables_touched,
    },
  };
}

/** While a run is still going: the dots as far as the snapshot knows them, and nothing else claimed. */
export function roomsWhileLive(run: Run): PublicHero {
  const tablesInSnapshot = Object.entries(run.snapshot?.tables ?? {});
  return {
    run_id: run.id,
    measured_at: run.created_at ?? null,
    incident: {},
    command: [],
    timeline: [],
    phases: {},
    tables: [],
    snapshot_rows: Object.fromEntries(tablesInSnapshot.map(([name, t]) => [name, t.rows ?? 0])),
    edges: [],
    totals: {},
    metrics: [],
    guardrails: { passed: 0, total: 0 },
    probes: [],
    secret_scan: {},
    teardown: {},
    prod: {},
  };
}

const LIVE_WORDS: Partial<Record<string, (e: TimelineEvent) => [string, string?, ('good' | 'bad')?]>> = {
  snapshot_taken: (e) => ['snapshot', isNum(e.detail?.ms) ? `${Math.round(e.detail?.ms as number)} ms` : undefined],
  planning: () => ['agent planning'],
  plan_frozen: (e) => ['plan', short(e.detail?.plan_hash as string, 12).replace('…', '')],
  static_gate: (e) => ['static gate', e.detail?.verdict as string | undefined],
  rehearsal_started: () => ['rehearsal', 'started'],
  rehearsal_finished: (e) => ['rehearsal', isNum(e.detail?.ms) ? `${Math.round(e.detail?.ms as number).toLocaleString('en-US')} ms` : 'finished'],
  guardrails_checked: (e) => {
    const failed = (e.detail?.failed as number | undefined) ?? 0;
    return ['guardrails', `${num(e.detail?.passed)} passed`, failed > 0 ? 'bad' : 'good'];
  },
  reproducing: () => ['second clone', 'running'],
  reproduced: (e) => ['second clone', e.detail?.ok ? 'same' : 'different', e.detail?.ok ? 'good' : 'bad'],
  prod_checked: (e) => ['prod hash', e.detail?.unchanged === true ? 'unchanged' : e.detail?.unchanged === false ? 'changed' : 'not checked', e.detail?.unchanged === true ? 'good' : e.detail?.unchanged === false ? 'bad' : undefined],
};

export function liveLines(run: Run): RoomsLive {
  const events = run.timeline ?? [];
  const lines = events.flatMap((e, i) => {
    const words = LIVE_WORDS[e.type]?.(e);
    return words ? [{ id: `${e.type}-${e.seq ?? i}`, label: words[0], value: words[1], tone: words[2] }] : [];
  });
  const latest = liveAttempts(events).at(-1);
  const scanning = run.status === 'rehearsing' || (!!latest?.started && !latest.finished);
  const note = run.status === 'queued' ? 'Queued' : run.status === 'snapshotting' ? 'Taking a snapshot of prod' : run.status === 'planning' ? 'The agent is writing a plan' : 'Nothing measured yet';
  return { lines: lines.slice(-40), scanning, note };
}

/** Prod's pane at the end of the run, by status. "Same" would be false on a plan that was really applied. */
export function prodViewFor(run: Run, moved: number): ProdView {
  const check = run.prod_check;
  const created = run.created_at ?? run.timeline?.[0]?.t;
  const checked = run.timeline?.find((e) => e.type === 'prod_checked');
  const checkedAt = isNum(checked?.t) && isNum(created) ? `+${(checked.t - created).toFixed(1)} s` : null;
  const atRehearsal = usable(check?.after ?? check?.before ?? run.snapshot?.digest);
  const after = usable(run.prod_after);
  const from = check?.measured_from ? `Measured from the ${check.measured_from}.` : 'Measured from the control plane.';
  const common = { checkedAt, moved, waiting: 'Not checked yet. The hash is measured last.' };

  if (run.status === 'applied') {
    return {
      ...common,
      word: 'applied',
      tone: 'good' as Tone,
      verdict: 'Counts matched',
      hashes: [
        { label: 'before', value: atRehearsal },
        { label: 'after', value: after },
      ],
      note: `The plan is on prod, so the hash moved. ${from}`,
    };
  }
  if ((run.status === 'rolled_back' || run.status === 'drift_detected') && after) {
    // What this apply did is the difference across the apply itself, when that was measured. A write from outside may have
    // moved the hash since the rehearsal, and that's why the run stopped, so it can't count against the rollback.
    const justBefore = beforeApplyHash(run);
    const baseline = justBefore ?? atRehearsal;
    const same = after === baseline;
    const failedRestore = run.apply?.restored === false;
    const verdict = run.status === 'rolled_back' ? 'Rolled back' : 'Refused';
    const outsideWrite = !!justBefore && justBefore !== atRehearsal;
    return {
      ...common,
      word: failedRestore ? 'moved' : same ? 'same' : 'moved',
      tone: failedRestore ? 'bad' : same ? 'good' : 'neutral',
      verdict: failedRestore ? 'Not restored' : verdict,
      hashes: [
        { label: justBefore ? 'before' : 'at rehearsal', value: baseline },
        { label: 'after', value: after },
      ],
      note: failedRestore
        ? `The restore failed. ${from}`
        : !same
          ? `Moved by a write from outside this run, not by this plan. ${from}`
          : outsideWrite
            ? `The apply changed nothing. An outside write had moved the hash before it. ${from}`
            : from,
    };
  }
  if (check?.error || check?.unchanged === null || check?.unchanged === undefined) {
    return {
      ...common,
      // Not compared yet is different from couldn't be compared.
      pending: isInProgress(run.status) && !check?.error,
      word: 'unknown',
      tone: 'neutral',
      verdict: 'Not measured',
      hashes: [{ label: 'snapshot', value: usable(run.snapshot?.digest) }],
      note: check?.error ?? 'Prod has not been checked after this rehearsal.',
    };
  }
  const ok = check.unchanged === true;
  return {
    ...common,
    word: ok ? 'same' : 'moved',
    tone: ok ? 'good' : 'bad',
    verdict: ok ? 'Unchanged' : 'Changed',
    hashes: [
      { label: 'before', value: usable(check.before) },
      { label: 'after', value: usable(check.after) },
    ],
    note: from,
  };
}

// ------------------------------------------------------------------ Gantt

const PHASE_BARS: { key: string; name: string }[] = [
  { key: 'clone_boot_ms', name: 'boot' },
  { key: 'first_exec_ms', name: 'first exec' },
  { key: 'systemd_boot_ms', name: 'systemd boot' },
  { key: 'load_state_ms', name: 'load state' },
  { key: 'probe_ms', name: 'probes' },
  { key: 'execute_ms', name: 'execute' },
  { key: 'secret_scan_ms', name: 'secret scan' },
  { key: 'destroy_ms', name: 'destroy' },
];

function eventAt(run: Run, type: string, n?: number): TimelineEvent | undefined {
  return run.timeline?.find((e) => e.type === type && (n === undefined || e.detail?.attempt === n));
}

/** Phases end to end, then the guardrail check and the second clone, each from a real event or measurement. */
function barsForAttempt(run: Run, a: Attempt, withSnapshot: boolean): GanttBar[] {
  const bars: GanttBar[] = [];
  let at = 0;
  const push = (name: string, ms: number, extra: Partial<GanttBar> = {}) => {
    bars.push({ name, start: at, ms, ...extra });
    at += ms;
  };
  const snap = snapshotEvent(run);
  if (withSnapshot && isNum(snap?.detail?.ms)) push('snapshot', snap?.detail?.ms as number, { note: snap?.detail?.cached ? 'cached' : undefined });
  const phases = (a.rehearsal?.phases ?? {}) as Record<string, number | undefined>;
  const failed = a.verdict !== 'passed' && !!a.verdict;
  for (const p of PHASE_BARS) {
    const v = phases[p.key];
    if (isNum(v)) push(p.name, v, p.key === 'execute_ms' && failed ? { tone: 'bad' } : {});
  }
  const finished = eventAt(run, 'rehearsal_finished', a.n);
  const checked = eventAt(run, 'guardrails_checked', a.n);
  if (isNum(finished?.t) && isNum(checked?.t)) {
    const count = failedGuardrails(a);
    push('guardrails', Math.max(0, (checked.t - finished.t) * 1000), { tone: count > 0 ? 'bad' : (a.guardrails?.length ?? 0) > 0 ? 'good' : undefined });
  }
  if (isNum(a.reproduced?.ms)) push('second clone', a.reproduced.ms, { tone: a.reproduced.ok ? 'good' : 'bad' });
  return bars;
}

/** The apply on its own row, because it happens long after the rehearsals and on another system. */
function applyRow(run: Run): GanttAttempt | null {
  const started = eventAt(run, 'apply_started');
  if (!started || !isNum(started.t)) return null;
  const a = run.apply;
  const bars: GanttBar[] = [];
  let at = 0;
  const backup = eventAt(run, 'backup_written');
  if (isNum(backup?.detail?.ms)) {
    bars.push({ name: 'backup', start: 0, ms: backup.detail.ms as number });
    at += backup.detail.ms as number;
  }
  if (run.status === 'applying') {
    bars.push({ name: 'apply', start: at, ms: Math.max(50, Date.now() - started.t * 1000 - at), live: true });
    return { label: 'Apply', outcome: 'Running', tone: 'live', bars };
  }
  const outcome = a?.outcome ?? run.status;
  const committed = outcome === 'committed';
  const tone: Tone = committed ? 'good' : outcome === 'drift_detected' ? 'caution' : 'bad';
  if (isNum(a?.ms)) bars.push({ name: 'apply', start: at, ms: a.ms, tone: committed ? 'good' : tone === 'bad' ? 'bad' : undefined });
  return { label: 'Apply', outcome: committed ? 'Committed' : outcome === 'drift_detected' ? 'Refused, drift' : 'Rolled back', tone, bars };
}

export function ganttFromRun(run: Run, inProgress: boolean): GanttAttempt[] {
  const attempts = run.attempts ?? [];
  const rows: GanttAttempt[] = attempts.map((a, i) => ({
    id: a.n,
    label: `Attempt ${a.n}`,
    outcome: verdictText(a.verdict, failedGuardrails(a)),
    tone: verdictTone(a.verdict),
    note: a.plan_hash ? `plan ${short(a.plan_hash, 8).replace('…', '')}` : undefined,
    bars: barsForAttempt(run, a, i === 0),
  }));
  if (!rows.length) {
    // Attempts only arrive when the agent loop ends. Until then the timeline is all there is.
    const live = liveAttempts(run.timeline);
    live.forEach((a, i) => {
      const started = eventAt(run, 'rehearsal_started', a.n);
      const isLast = i === live.length - 1;
      const bars: GanttBar[] = [];
      if (a.started && isNum(started?.t)) {
        if (a.finished && isNum(a.finishedMs)) bars.push({ name: 'rehearsal', start: 0, ms: a.finishedMs, tone: (a.failed ?? 0) > 0 ? 'bad' : undefined });
        else if (isLast && inProgress) bars.push({ name: 'rehearsal', start: 0, ms: Math.max(50, Date.now() - started.t * 1000), live: true });
      }
      rows.push({
        id: a.n,
        label: `Attempt ${a.n}`,
        outcome: a.guardrailsChecked ? ((a.failed ?? 0) > 0 ? `failed ${a.failed} guardrails` : 'passed') : a.started ? 'rehearsing' : 'planning',
        tone: a.guardrailsChecked ? ((a.failed ?? 0) > 0 ? 'bad' : 'good') : 'live',
        note: a.planHash ? `plan ${short(a.planHash, 8).replace('…', '')}` : undefined,
        bars,
      });
    });
  }
  const apply = applyRow(run);
  if (apply) rows.push(apply);
  return rows;
}

/** Only advances on what the server has really recorded. */
export function stepperFromRun(run: Run): GanttStep[] {
  const has = (type: string) => !!run.timeline?.some((e) => e.type === type);
  const auto = has('auto_approved_within_budget') || run.approval?.kind === 'auto_budget';
  const stoppedAt = run.status === 'blocked';
  const anyFailed = (run.final?.verdict ?? '') !== 'passed' && !!run.final?.verdict;
  const applyOutcome = run.status === 'applied' ? 'Applied' : run.status === 'rolled_back' ? 'Rolled back' : run.status === 'drift_detected' ? 'Refused, drift' : 'Applied';
  const applyTone: Tone | undefined = run.status === 'applied' ? 'good' : run.status === 'rolled_back' ? 'bad' : run.status === 'drift_detected' ? 'caution' : undefined;
  const person = run.status === 'rejected' ? 'Rejected' : auto ? 'No person needed' : 'Waiting for a person';
  const decided = auto || has('awaiting_approval') || ['awaiting_approval', 'approved', 'applied', 'rolled_back', 'drift_detected', 'rejected', 'applying'].includes(run.status);
  return [
    { label: 'Frozen', reached: has('plan_frozen') },
    { label: 'Rehearsed', reached: has('rehearsal_finished'), tone: has('rehearsal_finished') && stoppedAt && !has('guardrails_checked') ? 'bad' : undefined },
    { label: stoppedAt ? (anyFailed && has('guardrails_checked') ? 'Checked, and blocked' : 'Blocked') : 'Checked', reached: has('guardrails_checked') || stoppedAt, tone: stoppedAt ? 'bad' : has('guardrails_checked') ? 'good' : undefined },
    { label: person, reached: decided, tone: run.status === 'awaiting_approval' ? 'wait' : undefined },
    { label: applyOutcome, reached: ['applied', 'rolled_back', 'drift_detected'].includes(run.status), tone: applyTone },
  ];
}
