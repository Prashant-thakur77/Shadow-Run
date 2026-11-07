import type { Attempt, Run, TimelineEvent } from '../api/types';
import { isNum, ms, num, plural, short } from '../lib/format';
import { verdictText, verdictTone, type Tone } from '../lib/status';

/** What the timeline says about an attempt. `attempts` only arrives once the agent loop ends, so a live run is told from this. */
export interface LiveAttempt {
  n: number;
  planning?: boolean;
  planHash?: string;
  steps?: number;
  gateVerdict?: string;
  gateFindings?: number;
  started?: boolean;
  finishedMs?: number | null;
  finished?: boolean;
  contained?: boolean;
  guardrailsChecked?: boolean;
  passed?: number;
  failed?: number;
  failedNames?: string[];
}

export function liveAttempts(timeline: TimelineEvent[] = []): LiveAttempt[] {
  const byN = new Map<number, LiveAttempt>();
  for (const e of timeline) {
    const n = e.detail?.attempt;
    if (typeof n !== 'number') continue;
    const a = byN.get(n) ?? { n };
    const d = e.detail ?? {};
    if (e.type === 'planning') a.planning = true;
    if (e.type === 'plan_frozen') {
      a.planHash = d.plan_hash as string | undefined;
      a.steps = d.steps as number | undefined;
    }
    if (e.type === 'static_gate') {
      a.gateVerdict = d.verdict as string | undefined;
      a.gateFindings = d.findings as number | undefined;
    }
    if (e.type === 'rehearsal_started') a.started = true;
    if (e.type === 'rehearsal_finished') {
      a.finished = true;
      a.finishedMs = d.ms as number | undefined;
      a.contained = d.contained as boolean | undefined;
    }
    if (e.type === 'guardrails_checked') {
      a.guardrailsChecked = true;
      a.passed = d.passed as number | undefined;
      a.failed = d.failed as number | undefined;
      a.failedNames = d.failed_names as string[] | undefined;
    }
    byN.set(n, a);
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}

export interface StoryStep {
  n: number;
  text: string;
  tone: Tone;
  planHash?: string;
}

function liveStep(a: LiveAttempt, isLast: boolean, inProgress: boolean): StoryStep {
  let text = 'planning';
  let tone: Tone = 'live';
  if (a.gateVerdict === 'block') {
    text = 'blocked by the gate';
    tone = 'bad';
  } else if (a.guardrailsChecked) {
    const failed = a.failed ?? 0;
    text = failed ? `failed ${failed} ${plural(failed, 'guardrail')}` : 'passed';
    tone = failed ? 'bad' : 'good';
  } else if (a.finished) {
    // A rehearsal that ended without a guardrail check failed on the clone.
    if (isLast && inProgress) text = 'checking guardrails';
    else {
      text = 'failed on the clone';
      tone = 'bad';
    }
  } else if (a.started) text = 'rehearsing';
  else if (a.planHash) text = 'plan frozen';
  return { n: a.n, text, tone, planHash: a.planHash };
}

export function failedGuardrails(a: Attempt): number {
  return (a.guardrails ?? []).filter((g) => g.passed === false).length;
}

/** The plan only reads, so there is nothing to approve. The rows it read don't come back, so the page has to say that. */
export function isReadOnly(run: Run): boolean {
  return run.status === 'no_change' && !run.refused && run.final?.gate?.highest_risk === 'read';
}

/** The undo a person can start from an applied run. */
export function undoOnOffer(run: Run): boolean {
  const undo = run.final?.undo;
  return run.status === 'applied' && !run.undo_of && !!undo && undo.possible !== false && !undo.too_large_to_store;
}

const WORDS = (text: string) => new Set(text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));

/**
 * Why a plan a second model doubts differs from the request, when a measured failure forced the change. It reads only what
 * was measured: a guardrail that failed on an earlier attempt, and the doubt on the final one. Null unless both exist.
 */
export function changedToPass(attempts: Attempt[] | undefined, final: Attempt | null | undefined): string | null {
  const opinion = final?.second_opinion;
  if (!final || !opinion || opinion.error || (opinion.verdict !== 'partly' && opinion.verdict !== 'does_not')) return null;
  const broken = [...new Set((attempts ?? []).filter((a) => a.n < final.n && a.verdict === 'failed_guardrails').flatMap((a) => (a.guardrails ?? []).filter((g) => g.passed === false).map((g) => g.name ?? g.id ?? '')))].filter(Boolean);
  if (!broken.length) return null;
  // Of the rules an earlier plan broke, name the one closest to what the doubt is about. What was left out counts for more
  // than what was added, because the rule that stopped the request is what a person has to weigh.
  const leftOut = WORDS(opinion.left_out ?? '');
  const added = WORDS(opinion.added ?? '');
  const score = (name: string) => [...WORDS(name)].reduce((sum, w) => sum + (leftOut.has(w) ? 2 : added.has(w) ? 1 : 0), 0);
  const named = [...broken].sort((a, b) => score(b) - score(a))[0];
  const more = broken.length - 1;
  return `An earlier plan broke the guardrail "${named}"${more ? ` and ${num(more)} more` : ''}. A person can't approve past a guardrail, so the agent changed the plan to satisfy it, and that is why it differs from what you asked. Approve if that is acceptable.`;
}

export function storySteps(run: Run, inProgress: boolean): StoryStep[] {
  const attempts = run.attempts ?? [];
  if (attempts.length) {
    return attempts.map((a) => ({
      n: a.n,
      text: a.verdict === 'invalid_plan' && !a.plan?.steps?.length ? 'no plan' : verdictText(a.verdict, failedGuardrails(a)),
      tone: verdictTone(a.verdict),
      planHash: a.plan_hash,
    }));
  }
  const live = liveAttempts(run.timeline);
  return live.map((a, i) => liveStep(a, i === live.length - 1, inProgress));
}

export function snapshotEvent(run: Run): TimelineEvent | undefined {
  return run.timeline?.find((e) => e.type === 'snapshot_taken');
}

export function selectedAttempt(run: Run, selected: number | null): Attempt | null {
  const attempts = run.attempts ?? [];
  if (!attempts.length) return run.final ?? null;
  return (
    attempts.find((a) => a.n === selected) ??
    attempts.find((a) => a.n === run.final_attempt) ??
    run.final ??
    attempts[attempts.length - 1]
  );
}

/**
 * The retry loop can narrow a request until it passes. Compares the final plan with the first attempt
 * that was measured. Null unless both row counts exist, so a missing count never reads as a smaller one.
 */
export function narrowedRows(run: Run): { first: number; final: number } | null {
  const attempts = run.attempts ?? [];
  if (attempts.length < 2) return null;
  const measured = attempts.find((a) => a.report);
  const last = attempts.find((a) => a.n === run.final_attempt) ?? run.final ?? attempts[attempts.length - 1];
  if (!measured || !last || measured.n === last.n) return null;
  const first = measured.report?.totals?.rows_changed;
  const final = last.report?.totals?.rows_changed;
  return isNum(first) && isNum(final) && final < first ? { first, final } : null;
}

/** The server stays in `snapshotting` while it scans the snapshot, so the timeline tells the two apart. */
export function statusWord(run: Run, fallback: string): string {
  if (run.status === 'snapshotting' && snapshotEvent(run)) return 'Scanning the snapshot';
  return fallback;
}

/** The plan hash, from the moment the plan is frozen. */
export function currentPlanHash(run: Run): string | null {
  const live = liveAttempts(run.timeline);
  return run.plan_hash ?? run.final?.plan_hash ?? live[live.length - 1]?.planHash ?? null;
}

const d = (e: TimelineEvent, k: string) => e.detail?.[k];

/** A plain sentence for each timeline event, from its real detail fields. */
export function eventText(e: TimelineEvent): string {
  const at = typeof d(e, 'attempt') === 'number' ? `Attempt ${d(e, 'attempt')}: ` : '';
  switch (e.type) {
    case 'run_created':
      return 'Run created.';
    case 'snapshot_taken':
      return `Snapshot ${short(d(e, 'snapshot_id') as string, 16)} ${d(e, 'cached') ? 'reused from cache' : 'taken'} in ${ms(d(e, 'ms'))}.`;
    case 'injected_text_flagged':
      return `${num(d(e, 'rows'))} stored rows read like instructions. ${num(d(e, 'unsafe'))} judged unsafe.`;
    case 'planning':
      return `${at}the agent is planning.`;
    case 'agent_reads':
      return `${at}the agent read from the clone.`;
    case 'plan_frozen':
      return `${at}plan frozen, ${num(d(e, 'steps'))} ${plural(Number(d(e, 'steps')), 'step')}, hash ${short(d(e, 'plan_hash') as string, 10)}.`;
    case 'static_gate':
      return `${at}static gate said ${d(e, 'verdict') ?? 'nothing'}, ${num(d(e, 'findings'))} ${plural(Number(d(e, 'findings')), 'finding')}.`;
    case 'rehearsal_started':
      return `${at}rehearsal started in a new microVM.`;
    case 'rehearsal_finished':
      return `${at}rehearsal finished in ${ms(d(e, 'ms'))}, ${d(e, 'contained') ? 'contained' : 'NOT contained'}.`;
    case 'guardrails_checked':
      return `${at}guardrails checked, ${num(d(e, 'passed'))} passed, ${num(d(e, 'failed'))} failed.`;
    case 'reproducing':
      return `${at}a second microVM is repeating the rehearsal.`;
    case 'reproduced':
      return `${at}second clone ${d(e, 'ok') ? 'measured the same result' : 'measured a DIFFERENT result'}.`;
    case 'prod_checked':
      return d(e, 'unchanged') === true ? 'Prod hash checked again from outside the sandbox: unchanged.' : d(e, 'unchanged') === false ? 'Prod hash checked again from outside the sandbox: CHANGED.' : 'Prod hash could not be checked again.';
    case 'no_change':
      return 'The rehearsal changed nothing, so nothing was applied.';
    case 'run_blocked':
      return `Run blocked: ${String(d(e, 'reason') ?? 'no reason given').replace(/_/g, ' ')}.`;
    case 'awaiting_approval':
      return 'Outside the budget. Waiting for a different person to approve.';
    case 'auto_approved_within_budget':
      return 'Within the budget. Approved automatically.';
    case 'approved':
      return `Approved by ${d(e, 'approver') ?? e.actor ?? 'unknown'}.`;
    case 'rejected':
      return `Rejected by ${d(e, 'by') ?? e.actor ?? 'unknown'}.`;
    case 'apply_started':
      return `Apply started by ${e.actor ?? 'unknown'}, drift check ${d(e, 'drift_check') === false ? 'off' : 'on'}.`;
    case 'backup_written':
      return `Backup written in ${ms(d(e, 'ms'))}.`;
    case 'apply_committed':
      return `Committed. ${d(e, 'reason') ?? ''}`.trim();
    case 'apply_rolled_back':
      return `Rolled back: ${d(e, 'reason') ?? 'no reason given'}.`;
    case 'apply_drift_detected':
      return `Drift detected. ${d(e, 'reason') ?? ''}`.trim();
    case 'evidence_written':
      return `Evidence written, bundle ${short(d(e, 'bundle_sha256') as string, 10)}.`;
    case 'run_error':
      return `Run failed: ${d(e, 'error') ?? 'no detail'}`;
    default:
      return e.type.replace(/_/g, ' ');
  }
}

export function offset(run: Run, e: TimelineEvent): string {
  const base = run.created_at ?? run.timeline?.[0]?.t;
  if (!isNum(base) || !isNum(e.t)) return '';
  return `+${Math.max(0, e.t - base).toFixed(1)} s`;
}
