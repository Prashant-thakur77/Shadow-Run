import type { Run } from '../api/types';
import { usd, when } from '../lib/format';
import { Link } from '../lib/router';
import { isInProgress, statusInfo } from '../lib/status';
import { Hash, Mark } from '../ui/bits';
import { currentPlanHash, eventText, statusWord } from './derive';

function statusLine(run: Run): string | null {
  switch (run.status) {
    case 'blocked':
      return run.blocked_reason ?? null;
    case 'error':
      return run.error ?? 'The run failed and gave no detail.';
    case 'awaiting_approval':
      return run.can?.approve
        ? 'The rehearsal passed. It is outside the budget, so your approval is needed.'
        : 'The rehearsal passed. It is outside the budget, so a different person has to approve it.';
    case 'approved':
      return `Approved by ${run.approval?.approver_id ?? 'unknown'}. Not applied yet.`;
    case 'applied':
      return run.approval?.kind === 'auto_budget'
        ? `Within the budget, so it was approved automatically. ${run.apply?.reason ?? ''}`.trim()
        : (run.apply?.reason ?? null);
    case 'rolled_back':
    case 'drift_detected':
      return run.apply?.reason ?? null;
    case 'no_change':
      return 'The rehearsal changed nothing, so nothing reached prod.';
    case 'rejected':
      return `Rejected by ${run.rejection?.by ?? 'unknown'}.${run.rejection?.reason ? ` Reason: ${run.rejection.reason}` : ''}`;
    default: {
      const last = run.timeline?.[run.timeline.length - 1];
      return isInProgress(run.status) && last ? eventText(last) : null;
    }
  }
}

export function RunHeader({ run }: { run: Run }) {
  const info = statusInfo(run.status);
  const line = statusLine(run);
  const decisionWaiting = run.status === 'awaiting_approval' || run.status === 'approved';
  return (
    <header className={`runhead tone-${info.tone}`}>
      <div className="runhead-status">
        <Mark tone={info.tone} size={44} />
        <h1 className="runhead-word">{statusWord(run, info.label)}</h1>
      </div>
      {line && <p className="runhead-line">{line}</p>}
      {decisionWaiting && (
        <p className="runhead-jump">
          <a className="btn" href="#decision">
            {run.status === 'approved' ? 'Go to apply' : 'Go to the decision'}
          </a>
        </p>
      )}
      <div className="runhead-task">
        <span className="label">Task</span>
        <p className="runhead-tasktext">{run.task || 'No task. A plan was submitted directly, so the agent was skipped.'}</p>
      </div>
      <dl className="runhead-meta">
        <div>
          <dt>Plan hash</dt>
          <dd>
            {currentPlanHash(run) ? <Hash value={currentPlanHash(run)} /> : <span className="mono muted">not frozen yet</span>}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd className="mono">{usd(run.cost_usd)}</dd>
        </div>
        <div>
          <dt>Requested by</dt>
          <dd className="mono">{run.requester ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd className="mono">{when(run.created_at)}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd className="mono">{run.target_id ?? 'unknown'}</dd>
        </div>
        <div>
          <dt>Run</dt>
          <dd>
            <Hash value={run.id} chars={20} />
          </dd>
        </div>
      </dl>
      {run.rehearses_again && (
        <p className="muted runhead-again">
          Same plan as <Link href={`/runs/${encodeURIComponent(run.rehearses_again)}`}>run {run.rehearses_again}</Link>, rehearsed again on a new snapshot.
        </p>
      )}
    </header>
  );
}
