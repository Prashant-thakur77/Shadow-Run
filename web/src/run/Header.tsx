import type { ReactNode } from 'react';
import type { Run } from '../api/types';
import { short, usd, when } from '../lib/format';
import { Link } from '../lib/router';
import { isInProgress, runInfo } from '../lib/status';
import { Hash, Mark } from '../ui/bits';
import { Label } from '../ui/Label';
import { changedToPass, currentPlanHash, eventText, isReadOnly, statusWord, undoOnOffer } from './derive';
import { handedOffRun } from './handoff';
import { prodViewFor } from './rooms';

/** What a stopped apply left behind. Only said when the run shows it. */
function afterRollback(run: Run): string {
  if (run.apply?.restored === true) return 'The server was restored from its state archive.';
  if (run.apply?.restored === false) return 'The server could not be restored from its state archive.';
  return run.final?.report?.kind === 'host' ? '' : 'The transaction rolled back, so nothing from this plan is on prod.';
}

function statusLine(run: Run): string | null {
  if (run.refused) return `The agent refused this request.${run.refused.reason ? ` ${run.refused.reason}` : ''}`;
  switch (run.status) {
    case 'blocked':
      return run.blocked_reason ?? null;
    case 'error':
      return run.error ?? 'The run failed and gave no detail.';
    case 'awaiting_approval':
      if (run.race) return 'The rehearsal passed. This run is part of a race, which only rehearses, so it stays here.';
      if (run.expired) return `The rehearsal passed, but the approval window closed on ${when(run.approval_expires_at)}. Nothing reached prod. Prod may have changed since, so the plan has to be rehearsed again.`;
      if (run.from_race && run.final?.budget?.within) return 'The rehearsal passed. This plan could apply alone, but it came from a race, so it waits for a person.';
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
      return isReadOnly(run) ? 'This plan only reads, so nothing changed. Shadow Run is for changes, and it does not return what a query finds.' : 'The rehearsal changed nothing, so nothing reached prod.';
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

/** What this run can do next, in a sentence. The sticky bar has the button. */
function nextStep(run: Run): ReactNode {
  if (run.race) return null;
  const other = run.requester === 'reviewer' ? 'judge' : 'reviewer';
  switch (run.status) {
    case 'awaiting_approval':
      if (run.expired) return null;
      return run.can?.approve ? (
        <>
          Next: approve it, or first <a href="#break">try to break it</a>.
        </>
      ) : (
        `Next: switch to ${other}. A different person has to approve it.`
      );
    case 'approved':
      return run.can?.apply ? (
        <>
          Next: apply it. Or first <a href="#break">change prod behind its back</a>, and watch the apply stop.
        </>
      ) : null;
    case 'rolled_back':
    case 'drift_detected':
      return run.can?.rehearse_again ? 'Next: rehearse again. That used up the approval, and the plan has to be measured against prod as it is now.' : null;
    case 'applied':
      return undoOnOffer(run) ? 'Next: undo it. The undo goes through the same checks as any other plan.' : null;
    default:
      return null;
  }
}

export function RunHeader({ run, origin }: { run: Run; origin?: Run | null }) {
  const info = runInfo(run);
  const line = statusLine(run);
  const next = nextStep(run);
  // Only while someone is deciding. A plan from a race was written in that race, so the attempts and the doubt are on its run.
  const because = run.status === 'awaiting_approval' && !run.expired ? changedToPass(origin?.attempts ?? run.attempts, origin?.final ?? run.final) : null;
  const decisionWaiting = (run.status === 'awaiting_approval' && !run.expired) || run.status === 'approved';
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
        {because && <p className="runhead-because">{because}</p>}
        {next && <p className="runhead-next">{next}</p>}
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
