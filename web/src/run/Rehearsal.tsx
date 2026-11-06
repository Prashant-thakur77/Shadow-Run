import { useEffect, useMemo, useState } from 'react';
import type { Attempt, Phases, Run } from '../api/types';
import { clockTime, isNum, ms } from '../lib/format';
import { Fold, Mark, Notice } from '../ui/bits';
import { RunGantt } from '../ui/RunGantt';
import { eventText, liveAttempts, offset, snapshotEvent } from './derive';
import { ganttFromRun, stepperFromRun } from './rooms';

/** Prod's hash could not be compared. When it could, the right-hand room at the top of the page says so, larger. */
function ProdCheckProblem({ check }: { check: NonNullable<Run['prod_check']> }) {
  if (check.error || check.unchanged === null || check.unchanged === undefined) {
    return (
      <Notice tone="caution" title="Prod could not be checked after this rehearsal.">
        <span className="mono">{check.error ?? 'No detail given.'}</span>
      </Notice>
    );
  }
  if (check.unchanged === false) {
    return (
      <div className="prodcheck tone-bad">
        <div className="prodcheck-word">
          <Mark tone="bad" size={20} />
          Prod changed during this rehearsal
        </div>
        {check.measured_from && <p className="prodcheck-from">Measured from the {check.measured_from}.</p>}
      </div>
    );
  }
  return null;
}

const MEASURED: (keyof Phases)[] = ['clone_boot_ms', 'first_exec_ms', 'systemd_boot_ms', 'load_state_ms', 'probe_ms', 'execute_ms', 'secret_scan_ms', 'destroy_ms'];

export function RehearsalSection({ run, attempt, inProgress, selected, onSelect }: { run: Run; attempt: Attempt | null; inProgress: boolean; selected: number | null; onSelect: (n: number) => void }) {
  const snap = snapshotEvent(run);
  const phases = attempt?.rehearsal?.phases;
  const live = liveAttempts(run.timeline);
  const lastLive = live[live.length - 1];
  const measured = phases && MEASURED.some((k) => isNum(phases[k]));
  const rehearsing = !measured && inProgress && !!lastLive?.started && !lastLive.finished;
  const finishedNoDetail = !measured && inProgress && !!lastLive?.finished;
  const neverRan = !measured && !inProgress && !attempt?.rehearsal;
  const total = phases?.total_ms;

  // A bar for something still running grows with the wall clock. It is never given a printed number.
  const [, setTick] = useState(0);
  const moving = run.status === 'applying' || rehearsing;
  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 500);
    return () => window.clearInterval(timer);
  }, [moving]);

  const rows = ganttFromRun(run, inProgress);
  const stepper = useMemo(() => stepperFromRun(run), [run]);

  return (
    <>
      <RunGantt className="run-gantt" attempts={rows} stepper={stepper} selected={selected} onSelect={onSelect} />

      <p className="rehearsal-sum">
        {measured && isNum(total) && (
          <>
            <strong className="mono rehearsal-total">{ms(total)}</strong> from boot to destroy for attempt {attempt?.n}, snapshot not included
            {attempt?.rehearsal?.sandbox ? (
              <>
                , in <code className="mono">{attempt.rehearsal.sandbox}</code>
              </>
            ) : null}
            .
          </>
        )}
        {rehearsing && <>Rehearsing attempt {lastLive?.n} in a new microVM. Phase times appear when the run concludes.</>}
        {finishedNoDetail && (
          <>
            <strong className="mono rehearsal-total">{ms(lastLive?.finishedMs)}</strong> for attempt {lastLive?.n}. Phase times appear when the run concludes.
          </>
        )}
        {!measured && !rehearsing && !finishedNoDetail && inProgress && (
          <>
            {run.status === 'queued' && 'Queued.'}
            {run.status === 'snapshotting' && (snap ? 'Snapshot taken. Scanning its stored text for rows that read like instructions.' : 'Taking a snapshot of prod to clone from.')}
            {run.status === 'planning' && 'The agent is writing a plan. Nothing runs until the plan is frozen and hashed.'}
            {run.status === 'rehearsing' && 'The plan is frozen. Starting a microVM.'}
            {run.status === 'applying' && 'Rehearsal finished. Now applying to prod.'}
          </>
        )}
        {neverRan && (live.some((a) => a.started) ? <>The run stopped before it reported phase times.</> : <>No sandbox was started for this attempt.</>)}
      </p>

      {run.prod_check && <ProdCheckProblem check={run.prod_check} />}

      {attempt?.rehearsal?.sandbox_error && (
        <Notice tone="bad" title="The sandbox failed. Unknown is not safe.">
          {attempt.rehearsal.sandbox_error}
        </Notice>
      )}

      {(run.timeline?.length ?? 0) > 0 && (
        <Fold open={inProgress} summary={`Event log, ${run.timeline?.length} events`}>
          <ol className="eventlog">
            {run.timeline?.map((e, i) => (
              <li key={e.seq ?? i}>
                <span className="mono eventlog-time" title={clockTime(e.t)}>
                  {offset(run, e)}
                </span>
                <span>{eventText(e)}</span>
              </li>
            ))}
          </ol>
        </Fold>
      )}
    </>
  );
}
