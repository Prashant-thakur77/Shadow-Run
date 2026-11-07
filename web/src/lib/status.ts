export type Tone = 'good' | 'bad' | 'caution' | 'wait' | 'live' | 'neutral';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'live' },
  snapshotting: { label: 'Taking a snapshot', tone: 'live' },
  planning: { label: 'Agent is planning', tone: 'live' },
  rehearsing: { label: 'Rehearsing on a clone', tone: 'live' },
  applying: { label: 'Applying to prod', tone: 'live' },
  awaiting_approval: { label: 'Awaiting approval', tone: 'wait' },
  approved: { label: 'Approved', tone: 'wait' },
  blocked: { label: 'Blocked', tone: 'bad' },
  applied: { label: 'Applied', tone: 'good' },
  rolled_back: { label: 'Rolled back', tone: 'bad' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  drift_detected: { label: 'Drift detected', tone: 'caution' },
  no_change: { label: 'No change', tone: 'neutral' },
  error: { label: 'Error', tone: 'bad' },
};

export function statusInfo(status: string | undefined): { label: string; tone: Tone } {
  if (status && STATUS[status]) return STATUS[status];
  return { label: status ? status.replace(/_/g, ' ') : 'Unknown', tone: 'neutral' };
}

/** The word for a run, when the stored status alone would say the wrong thing: a window that has closed, a race's lane that
 *  can never be approved, or an agent that declined. Both a run and a row of the list carry what this reads. */
export function runInfo(run: { status?: string; expired?: boolean; refused?: unknown; race?: unknown; race_lane?: unknown }): { label: string; tone: Tone } {
  const settled = !IN_PROGRESS.has(run.status ?? '');
  if (run.race || run.race_lane) return settled && run.status !== 'error' ? { label: 'Rehearsed only', tone: 'neutral' } : statusInfo(run.status);
  if (run.refused) return { label: 'Agent refused', tone: 'neutral' };
  if (run.expired) return { label: 'Expired', tone: 'neutral' };
  return statusInfo(run.status);
}

const IN_PROGRESS = new Set(['queued', 'snapshotting', 'planning', 'rehearsing', 'applying']);
const TERMINAL = new Set(['blocked', 'applied', 'rolled_back', 'rejected', 'drift_detected', 'no_change', 'error']);

export const isInProgress = (s?: string) => !!s && IN_PROGRESS.has(s);
export const isTerminal = (s?: string) => !!s && TERMINAL.has(s);

export function pollDelay(status: string | undefined, fast: boolean): number | null {
  if (isTerminal(status)) return null;
  if (isInProgress(status) || fast) return 1000;
  return 3000; // Waiting on a person, who may be in another tab.
}

const VERDICTS: Record<string, string> = {
  passed: 'passed',
  failed_guardrails: 'failed guardrails',
  evaded_rule: 'got around a rule',
  blocked_by_gate: 'blocked by the gate',
  sql_error: 'SQL error',
  read_only_plan: 'only read, so it was asked to try again',
  sandbox_error: 'sandbox error',
  invalid_plan: 'invalid plan',
};

export function verdictText(verdict: string | undefined, failedGuardrails?: number): string {
  if (verdict === 'failed_guardrails' && failedGuardrails) {
    return `failed ${failedGuardrails} ${failedGuardrails === 1 ? 'guardrail' : 'guardrails'}`;
  }
  if (verdict && VERDICTS[verdict]) return VERDICTS[verdict];
  return verdict ? verdict.replace(/_/g, ' ') : 'in progress';
}

export function verdictTone(verdict: string | undefined): Tone {
  if (verdict === 'passed') return 'good';
  // Only reading isn't a failure. The agent was told to go on, so it gets no red.
  if (verdict === 'read_only_plan') return 'neutral';
  if (!verdict) return 'live';
  return 'bad';
}
