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
  blocked_by_gate: 'blocked by the gate',
  sql_error: 'SQL error',
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
  if (!verdict) return 'live';
  return 'bad';
}
