import type { Run } from '../api/types';
import { short, usd, when } from '../lib/format';
import { Link } from '../lib/router';
import { isInProgress, statusInfo } from '../lib/status';
import { Hash, Mark } from '../ui/bits';
import { Label } from '../ui/Label';
import { currentPlanHash, eventText, statusWord } from './derive';
import { handedOffRun } from './handoff';
import { prodViewFor } from './rooms';

/** What a stopped apply left behind. Only said when the run shows it. */
function afterRollback(run: Run): string {
  if (run.apply?.restored === true) return 'The server was restored from its state archive.';
  if (run.apply?.restored === false) return 'The server could not be restored from its state archive.';
  return run.final?.report?.kind === 'host' ? '' : 'The transaction rolled back, so nothing from this plan is on prod.';
}

function statusLine(run: Run): string | null {
  switch (run.status) {
    case 'blocked':
      return run.blocked_reason ?? null;
    case 'error':
      return run.error ?? 'The run failed and gave no detail.';
    case 'awaiting_approval':
      if (run.race) return 'The rehearsal passed. This run is part of a race, which only rehearses, so it stays here.';
      if (run.rehearse_only && run.final?.budget?.within) return "The rehearsal passed. This run was asked to rehearse only, so nothing reaches prod until someone approves it.";
      return run.can?.approve
        ? "The rehearsal passed. It can't apply alone, so your approval is needed."
        : "The rehearsal passed. It can't apply alone, so a different person has to approve it.";
    case 'approved':
      return `Approved by ${run.approval?.approver_id ?? 'unknown'}. Not applied yet.`;
    case 'applied':
      return run.approval?.kind === 'auto_budget'
        ? `On the auto-apply list and inside the budget, so it was approved automatically. ${run.apply?.reason ?? ''}`.trim()
        : (run.apply?.reason ?? null);
    case 'rolled_back': {
      const reason = (run.apply?.reason ?? '').replace(/\.$/, '');
      return `${reason ? `${reason[0].toUpperCase()}${reason.slice(1)}. ` : ''}${afterRollback(run)}`.trim() || null;
    }
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

/** The block a task travels into from Home, shared with the page's first frame. */
export function TaskBlock({ run, text, plan }: { run?: Run; text?: string; plan?: boolean }) {
  const firstStep = run?.final?.plan?.steps?.[0]?.cmd ?? run?.attempts?.[0]?.plan?.steps?.[0]?.cmd;
  // Until the plan comes back from the server, what Home sent is still the best thing to show.
  const handed = run ? handedOffRun(run.id) : undefined;
  const task = text ?? run?.task ?? (firstStep ? undefined : handed?.text);
  const isPlan = plan ?? (!run?.task && (handed?.plan ?? true));
  return (
    <div className="runhead-task">
      <span className="label">{isPlan ? 'Plan' : 'Task'}</span>
      {task ? (
        <p className={isPlan ? 'runhead-tasktext is-plan' : 'runhead-tasktext'}>{task}</p>
      ) : (
        <>
          {firstStep && <p className="runhead-tasktext is-plan">{firstStep.slice(0, 400)}</p>}
          <p className="runhead-taskskip">No task. A plan was submitted directly, so the agent was skipped.</p>
        </>
      )}
    </div>
  );
}

export function RunHeader({ run }: { run: Run }) {
  const info = statusInfo(run.status);
  const line = statusLine(run);
  const decisionWaiting = run.status === 'awaiting_approval' || run.status === 'approved';
  const prod = prodViewFor(run, 0);
  const prodHash = prod.pending || prod.word === 'unknown' ? null : prod.hashes[prod.hashes.length - 1]?.value;
  return (
    <header className={`runhead tone-${info.tone}`}>
      <div className="runhead-verdict">
        <Label>The verdict</Label>
        <div className="runhead-status">
          <Mark tone={info.tone} size={44} />
          <h1 className="runhead-word t-display-l">{statusWord(run, info.label)}</h1>
        </div>
        {line && <p className="runhead-line">{line}</p>}
        {prodHash && (
          <p className="runhead-proof">
            <Mark tone={prod.tone} size={13} />
            <span>Prod: {prod.word}</span>
            <code>{short(prodHash, 8).replace('…', '')}</code>
          </p>
        )}
        {decisionWaiting && (
          <p className="runhead-jump">
            <a className="btn" href="#decision">
              {run.status === 'approved' ? 'Go to apply' : 'Go to the decision'}
            </a>
          </p>
        )}
      </div>
      <div className="runhead-facts">
        <TaskBlock run={run} />
        <dl className="runhead-meta">
          <div>
            <dt>Requested by</dt>
            <dd className="mono">{run.requester ?? 'unknown'}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd className="mono">{usd(run.cost_usd)}</dd>
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
            <dt>Plan hash</dt>
            <dd>{currentPlanHash(run) ? <Hash value={currentPlanHash(run)} /> : <span className="mono muted">not frozen yet</span>}</dd>
          </div>
          <div>
            <dt>Run</dt>
            <dd>
              <Hash value={run.id} chars={20} />
            </dd>
          </div>
        </dl>
        {run.undo_of && (
          <p className="muted runhead-again">
            This run undoes <Link href={`/runs/${encodeURIComponent(run.undo_of)}`}>run {run.undo_of}</Link>. It goes through the same pipeline as any other plan.
          </p>
        )}
        {run.rehearses_again && (
          <p className="muted runhead-again">
            Same plan as <Link href={`/runs/${encodeURIComponent(run.rehearses_again)}`}>run {run.rehearses_again}</Link>, rehearsed again on a new snapshot.
          </p>
        )}
      </div>
    </header>
  );
}
