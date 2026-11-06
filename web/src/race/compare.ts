import type { Attempt, GuardrailResult, Metric, Report, Run } from '../api/types';
import { money, num, plural } from '../lib/format';
import { isInProgress, type Tone } from '../lib/status';
import { dollarsLost, hasMoved, metricDelta } from '../run/metrics';

/** What one lane has come to so far. Everything here is read from the run, and nothing is worked out ahead of a measurement. */
export interface Lane {
  run: Run | null;
  settled: boolean;
  final: Attempt | null;
  /** The measurements of the plan the lane ended on. Null if that plan errored or never ran, so a missing number can't read as a zero. */
  report: Report | null;
  /** Why it has no numbers, in the words of the error. */
  failure: string | null;
  /** The lane ended and has no plan to offer a person. */
  noPlan: boolean;
  broken: GuardrailResult[];
  guardrails: number;
}

export function finalAttempt(run: Run | null): Attempt | null {
  if (!run) return null;
  const attempts = run.attempts ?? [];
  return attempts.find((a) => a.n === run.final_attempt) ?? run.final ?? attempts[attempts.length - 1] ?? null;
}

/** An attempt's numbers, unless the plan failed partway and rolled back, when they would read as "nothing happened". */
export function measuredReport(a: Attempt | null | undefined): Report | null {
  if (!a?.report?.totals) return null;
  return a.rehearsal?.result?.ok === false ? null : a.report;
}

function failureOf(run: Run, final: Attempt | null): string | null {
  if (run.status === 'error') return run.error ?? 'The run failed and gave no detail.';
  if (!final) return null;
  if (final.error) return final.error;
  const onClone = final.rehearsal?.result;
  if (onClone?.ok === false) return onClone.error ?? 'The plan failed on the clone.';
  if (final.rehearsal?.sandbox_error) return final.rehearsal.sandbox_error;
  return null;
}

export function readLane(run: Run | null): Lane {
  const settled = !!run && !isInProgress(run.status);
  const final = finalAttempt(run);
  const guardrails = final?.guardrails ?? [];
  const report = settled ? measuredReport(final) : null;
  return {
    run,
    settled,
    final,
    report,
    failure: settled && run ? failureOf(run, final) : null,
    noPlan: settled && run?.race?.lane === 'through' && run.status !== 'awaiting_approval',
    broken: guardrails.filter((g) => g.passed === false),
    guardrails: guardrails.length,
  };
}

export interface Cell {
  text: string;
  /** A second, smaller line: where a dollar figure came from. */
  sub?: string;
  tone: Tone;
  /** Still running, so the cell holds no number yet. */
  pending?: boolean;
  /** A quiet word instead of a figure. */
  word?: boolean;
}

export interface VerdictRow {
  key: string;
  label: string;
  alone: Cell;
  through: Cell;
  lead?: boolean;
}

const PENDING: Cell = { text: 'Not measured yet', tone: 'neutral', pending: true, word: true };

/** The cell for a lane that has no number to give, and the reason in a word. */
function emptyCell(lane: Lane): Cell | null {
  if (!lane.settled) return PENDING;
  if (lane.noPlan) return { text: lane.run?.status === 'no_change' ? 'Changes nothing' : 'No plan', tone: 'neutral', word: true };
  if (!lane.report) return { text: lane.final?.verdict === 'invalid_plan' ? 'No plan' : lane.failure ? 'Errored' : 'Not measured', tone: 'neutral', word: true };
  return null;
}

function metricCell(lane: Lane, id: string): Cell {
  const empty = emptyCell(lane);
  if (empty) return empty;
  const m = lane.report?.metrics?.find((x) => x.id === id);
  if (!m) return { text: 'Not measured', tone: 'neutral', word: true };
  if (!hasMoved(m)) return { text: 'No change', tone: m.unit === 'usd' ? 'good' : 'neutral', word: true };
  const lost = dollarsLost(m);
  return { text: metricDelta(m), sub: m.unit === 'usd' ? `${money(m.before)} to ${m.lost_entirely ? 'gone' : money(m.after)}` : `${num(m.before)} to ${num(m.after)}`, tone: lost ? 'bad' : 'neutral' };
}

function countCell(lane: Lane, read: (r: Report) => number | null | undefined): Cell {
  const empty = emptyCell(lane);
  if (empty) return empty;
  const v = read(lane.report as Report);
  if (typeof v !== 'number') return { text: 'Not measured', tone: 'neutral', word: true };
  // A row count is harm only when the checks found harm in that plan. Deleting what a task asked for isn't.
  return { text: num(v), tone: v === 0 ? 'good' : lane.broken.length ? 'bad' : 'neutral' };
}

function guardrailCell(lane: Lane): Cell {
  const empty = emptyCell(lane);
  if (empty) return empty;
  if (!lane.guardrails) return { text: 'Not measured', tone: 'neutral', word: true };
  return { text: `${num(lane.broken.length)} of ${num(lane.guardrails)}`, tone: lane.broken.length ? 'bad' : 'good' };
}

const tableDeleted = (name: string) => (r: Report) => r.tables?.find((t) => t.table === name)?.deleted ?? 0;

/** Nothing to say: a zero, no change, or a word such as "Errored" that the sentence above the table already explains. */
const isQuiet = (c: Cell) => !!c.word || c.text === '0' || c.text.startsWith('0 of');

/** The table that lands as the lanes finish. Rows with nothing to say on either side leave once both sides are in. */
export function verdictRows(a: Lane, b: Lane): VerdictRow[] {
  const metric = (id: string, label: string, lead = false): VerdictRow => ({ key: id, label, alone: metricCell(a, id), through: metricCell(b, id), lead });
  const count = (key: string, label: string, read: (r: Report) => number | null | undefined): VerdictRow => ({ key, label, alone: countCell(a, read), through: countCell(b, read) });
  const known = new Set(['paid_invoices', 'order_value']);
  const moved = [...(a.report?.metrics ?? []), ...(b.report?.metrics ?? [])].filter((m): m is Metric & { id: string } => !!m.id && !known.has(m.id) && hasMoved(m));
  const others: VerdictRow[] = [];
  for (const m of moved) {
    if (known.has(m.id)) continue;
    known.add(m.id);
    others.push(metric(m.id, m.name ?? m.id, m.unit === 'usd'));
  }
  // Money first, because the sentence above leads with it. Counts of people and accounts last, because moving them is often the job.
  const rows: VerdictRow[] = [
    metric('paid_invoices', 'Paid invoices on record', true),
    metric('order_value', 'Customer order history', true),
    ...others.filter((r) => r.lead),
    count('invoices', 'Invoices deleted', tableDeleted('invoices')),
    count('orders', 'Orders deleted', tableDeleted('orders')),
    count('rows_deleted', 'Rows deleted, all tables', (r) => r.totals?.rows_deleted),
    count('rows_cascade', 'Rows changed by a cascade', (r) => r.totals?.rows_via_cascade),
    count('tables_dropped', 'Tables dropped', (r) => r.totals?.tables_dropped),
    { key: 'guardrails', label: 'Guardrails broken', alone: guardrailCell(a), through: guardrailCell(b) },
    ...others.filter((r) => !r.lead),
  ];
  if (!a.settled || !b.settled) return rows;
  return rows.filter((r) => r.key === 'rows_deleted' || r.key === 'guardrails' || !(isQuiet(r.alone) && isQuiet(r.through)));
}

export interface Verdict {
  tone: Tone;
  title: string;
  lines: string[];
  /** A second model's doubt about the plan the right lane ended on. It goes beside the numbers, not under them. */
  doubt: string | null;
}

interface Harm {
  label: string;
  alone: number;
  through: number;
  format: (v: number) => string;
}

const moneyLost = (lane: Lane, id: string): number => {
  const m = lane.report?.metrics?.find((x) => x.id === id);
  return m ? (dollarsLost(m) ?? 0) : 0;
};

/** What each side would have lost. These metrics overlap, so each is compared alone and they're never added up. */
function harms(a: Lane, b: Lane): Harm[] {
  const ids = new Set([...(a.report?.metrics ?? []), ...(b.report?.metrics ?? [])].filter((m) => m.unit === 'usd').map((m) => m.id ?? ''));
  const list: Harm[] = [...ids].map((id) => {
    const m = a.report?.metrics?.find((x) => x.id === id) ?? b.report?.metrics?.find((x) => x.id === id);
    return { label: (m?.name ?? id).toLowerCase().replace(/ on record$/, ''), alone: moneyLost(a, id), through: moneyLost(b, id), format: money };
  });
  const totals = (key: 'rows_deleted' | 'rows_via_cascade') => [a.report?.totals?.[key] ?? 0, b.report?.totals?.[key] ?? 0];
  const [delA, delB] = totals('rows_deleted');
  const [casA, casB] = totals('rows_via_cascade');
  list.push({ label: 'rows deleted', alone: delA, through: delB, format: num });
  list.push({ label: 'rows changed by a cascade', alone: casA, through: casB, format: num });
  list.push({ label: 'guardrails broken', alone: a.broken.length, through: b.broken.length, format: num });
  return list;
}

function opinionLine(b: Lane): string | null {
  const o = b.final?.second_opinion;
  if (!o || o.error || (o.verdict !== 'partly' && o.verdict !== 'does_not')) return null;
  const said = [o.left_out, o.added].filter(Boolean).join(' ');
  return `A second model ${o.verdict === 'does_not' ? 'says this does not do' : 'says this only partly does'} what was asked. ${said}`.trim();
}

function tries(b: Lane): string {
  const n = b.run?.attempts?.length ?? 0;
  return `${num(n)} ${plural(n, 'attempt')}`;
}

function rowsChanged(lane: Lane): string {
  const t = lane.report?.totals;
  return `${num(t?.rows_changed)} ${plural(t?.rows_changed ?? 0, 'row')}`;
}

const brokeWord = (lane: Lane) => (lane.broken.length ? `breaks ${num(lane.broken.length)} ${plural(lane.broken.length, 'guardrail')}` : 'breaks no guardrail');

/** The sentence over the lanes. Each case says what the two runs measured, and says so when Shadow Run did no better. */
export function verdict(a: Lane, b: Lane): Verdict | null {
  if (!a.settled || !b.settled) return null;
  const doubt = opinionLine(b);
  if (a.run?.status === 'error' || b.run?.status === 'error') {
    const which = a.run?.status === 'error' ? 'The agent alone' : 'Through Shadow Run';
    return { tone: 'neutral', title: 'One lane failed, so there is no comparison.', lines: [`${which}: ${a.run?.status === 'error' ? a.failure : b.failure}`], doubt: null };
  }

  const held = b.run?.status === 'awaiting_approval';
  const list = harms(a, b);
  const leftHarm = !!a.report && list.some((h) => h.alone > 0 && h.label !== 'rows deleted');

  if (!held) {
    const changesNothing = b.run?.status === 'no_change';
    const lines = [changesNothing ? `After ${tries(b)} the agent ended on a plan that changes nothing. If the task asked for a change, it isn't done.` : `After ${tries(b)} no plan passed, so nothing waits for a person and the task isn't done.`];
    if (b.failure && !changesNothing) lines.push(`The last attempt: ${b.failure}`);
    if (a.report) {
      const big = list.find((h) => h.alone > 0);
      lines.push(!big ? 'The agent alone would have changed nothing either.' : big.format === money ? `The agent alone would have lost ${money(big.alone)} of ${big.label}.` : `The agent alone would have gone ahead: ${big.format(big.alone)} ${big.label}.`);
    } else if (a.failure) {
      lines.push(`The agent's first plan failed too. ${a.failure}`);
    }
    // A plan the checks stopped isn't the same story as an agent that never wrote one that runs.
    const stopped = b.final?.verdict === 'failed_guardrails' || b.final?.verdict === 'blocked_by_gate';
    const title = changesNothing ? 'Through Shadow Run, the plan changes nothing.' : stopped ? 'Shadow Run stopped it, and the task is not done.' : 'The agent never wrote a plan that runs. The task is not done.';
    return { tone: leftHarm ? 'caution' : 'neutral', title, lines, doubt };
  }

  if (!a.report) {
    const lines = [`On prod that would have been the same error and no change, not damage. ${a.failure ?? ''}`.trim()];
    if (b.report) lines.push(`Through Shadow Run the agent read the error and rewrote the plan. After ${tries(b)} it ${brokeWord(b)} and waits for a person.`);
    return { tone: 'neutral', title: b.report ? `The agent alone stops at an error. Through Shadow Run, its plan changes ${rowsChanged(b)}.` : 'The agent alone stops at an error.', lines, doubt };
  }

  if (!leftHarm) {
    const same = a.final?.plan_hash === b.final?.plan_hash;
    const lines = [
      `The agent's first plan changes ${rowsChanged(a)} and ${brokeWord(a)}. Through Shadow Run the plan changes ${rowsChanged(b)} and ${brokeWord(b)}.${same ? ' Both lanes end on the same plan.' : ''}`,
      'On this task Shadow Run is not safer. What it adds is the measurement, and a person before prod.',
    ];
    return { tone: 'neutral', title: 'No guardrail broke and no money moved, so there was nothing to rescue.', lines, doubt };
  }

  const lead =
    list.find((h) => h.label.startsWith('paid invoices') && h.alone > 0) ??
    list.filter((h) => h.format === money && h.alone > 0).sort((x, y) => y.alone - x.alone)[0] ??
    list.find((h) => h.label === 'rows deleted' && h.alone > 0) ??
    list.find((h) => h.alone > 0);
  const notBetter = list.filter((h) => (h.alone > 0 && h.through >= h.alone) || (h.alone === 0 && h.through > 0));
  const lines = notBetter.map((h) => `On ${h.label}, Shadow Run did no better: ${h.format(h.through)} against ${h.format(h.alone)} for the agent alone.`);
  // A long list reads better in the lane's own detail. A short one is often the whole story.
  if (a.broken.length && a.broken.length <= 2) lines.unshift(`The agent alone breaks this rule: ${a.broken.map((g) => g.name).join(', and ')}.`);
  lines.push(`It took ${tries(b)}. The plan it ended on changes ${rowsChanged(b)} and ${brokeWord(b)}. It waits for a person.`);
  let title = 'The agent alone does damage. Through Shadow Run, less.';
  const worse = list.find((h) => h.format === money && h.through > h.alone);
  if (worse) title = `Through Shadow Run the plan loses ${money(worse.through)} of ${worse.label}. The agent alone loses ${worse.alone > 0 ? money(worse.alone) : 'none'}.`;
  else if (lead?.format === money) title = `The agent alone would lose ${money(lead.alone)} of ${lead.label}. Through Shadow Run, ${lead.through > 0 ? money(lead.through) : 'none'}.`;
  else if (lead) title = `The agent alone: ${num(lead.alone)} ${lead.label}. Through Shadow Run: ${num(lead.through)}.`;
  return { tone: notBetter.length ? 'caution' : 'good', title, lines, doubt };
}

/** A run in progress when the server restarts never reports again, and this is how a page can tell. */
const SILENT_S = 300;

/** A lane's own word for where it is, while it's moving and once it stops. */
export function laneWord(lane: Lane, name: 'alone' | 'through'): { text: string; tone: Tone } {
  const run = lane.run;
  if (!run) return { text: 'Not started', tone: 'neutral' };
  if (!lane.settled && typeof run.updated_at === 'number' && Date.now() / 1000 - run.updated_at > SILENT_S) {
    return { text: 'No word from this lane for 5 minutes. The server may have restarted, so start a new race.', tone: 'caution' };
  }
  const attempts = run.attempts ?? [];
  const last = attempts[attempts.length - 1];
  const n = attempts.length;
  switch (run.status) {
    case 'queued':
      return { text: 'Waiting for the snapshot', tone: 'live' };
    case 'snapshotting':
      return { text: 'Taking a snapshot of prod', tone: 'live' };
    case 'planning':
      if (last?.gate?.verdict === 'block' && !last.report) return { text: 'The gate refused this plan. Running it on a clone anyway, to measure it.', tone: 'live' };
      if (last?.report && !last.verdict) return { text: 'Measured. Checking the result.', tone: 'live' };
      return { text: n > 1 ? `Reading what was measured and rewriting. Attempt ${num(n)}.` : 'The agent is planning', tone: 'live' };
    case 'rehearsing':
      return { text: `Rehearsing attempt ${num(n)} in a microVM`, tone: 'live' };
    case 'awaiting_approval':
      return { text: 'Waiting for a person', tone: 'wait' };
    case 'blocked':
      return name === 'alone' ? { text: 'Refused', tone: 'bad' } : { text: 'Stopped', tone: 'bad' };
    case 'no_change':
      return { text: 'Changed nothing', tone: 'neutral' };
    case 'error':
      return { text: 'Failed', tone: 'bad' };
    default:
      return { text: run.status.replace(/_/g, ' '), tone: 'neutral' };
  }
}

/** Seconds from the start of a lane to the last thing it did. Null until it has stopped. */
export function laneSeconds(lane: Lane): number | null {
  const run = lane.run;
  const events = run?.timeline ?? [];
  const lastT = events[events.length - 1]?.t;
  if (!lane.settled || typeof run?.created_at !== 'number' || typeof lastT !== 'number') return null;
  return Math.max(0, lastT - run.created_at);
}

