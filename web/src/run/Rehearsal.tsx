import type { CSSProperties } from 'react';
import type { Attempt, Phases, Run } from '../api/types';
import { isNum, ms, clockTime } from '../lib/format';
import { Fold, Hash, Mark, Notice } from '../ui/bits';
import { eventText, liveAttempts, offset, snapshotEvent } from './derive';

const PHASES: { key: keyof Phases; label: string; hostOnly?: boolean }[] = [
  { key: 'clone_boot_ms', label: 'MicroVM boot' },
  { key: 'first_exec_ms', label: 'First exec' },
  { key: 'systemd_boot_ms', label: 'Systemd boot', hostOnly: true },
  { key: 'load_state_ms', label: 'Load state', hostOnly: true },
  { key: 'probe_ms', label: 'Isolation probes' },
  { key: 'execute_ms', label: 'Run plan' },
  { key: 'secret_scan_ms', label: 'Secret scan' },
  { key: 'destroy_ms', label: 'Destroy' },
];

type StepState = 'done' | 'live' | 'pending' | 'skipped';

/** Prod's hash before and after this rehearsal, taken from outside the sandbox. */
function ProdCheck({ check }: { check: NonNullable<Run['prod_check']> }) {
  if (check.error || check.unchanged === null || check.unchanged === undefined) {
    return (
      <Notice tone="caution" title="Prod could not be checked after this rehearsal.">
        <span className="mono">{check.error ?? 'No detail given.'}</span>
      </Notice>
    );
  }
  const ok = check.unchanged === true;
  return (
    <div className={`prodcheck ${ok ? 'tone-good' : 'tone-bad'}`}>
      <div className="prodcheck-word">
        <Mark tone={ok ? 'good' : 'bad'} size={20} />
        {ok ? 'Prod untouched by this rehearsal' : 'Prod changed during this rehearsal'}
      </div>
      <dl className="prodcheck-hashes">
        <div>
          <dt>Before</dt>
          <dd><Hash value={check.before} chars={16} /></dd>
        </div>
        <div>
          <dt>After</dt>
          <dd><Hash value={check.after} chars={16} /></dd>
        </div>
      </dl>
      {check.measured_from && <p className="prodcheck-from">Measured from the {check.measured_from}.</p>}
    </div>
  );
}

function Step({ label, state, value, note, strong }: { label: string; state: StepState; value?: string; note?: string; strong?: boolean }) {
  return (
    <li className={`phase is-${state}${strong ? ' is-strong' : ''}`}>
      <span className="phase-label">{label}</span>
      <span className="phase-ms mono">{value ?? (state === 'live' ? 'in progress' : state === 'skipped' ? 'skipped' : 'waiting')}</span>
      {note && <span className="phase-note">{note}</span>}
    </li>
  );
}

export function RehearsalSection({ run, attempt, inProgress }: { run: Run; attempt: Attempt | null; inProgress: boolean }) {
  const snap = snapshotEvent(run);
  const phases = attempt?.rehearsal?.phases;
  const live = liveAttempts(run.timeline);
  const lastLive = live[live.length - 1];
  const measured = phases && PHASES.some((p) => isNum(phases[p.key]));
  const shown = PHASES.filter((p) => !p.hostOnly || isNum(phases?.[p.key]));
  const rehearsing = !measured && inProgress && !!lastLive?.started && !lastLive.finished;
  const finishedNoDetail = !measured && inProgress && !!lastLive?.finished;
  const neverRan = !measured && !inProgress && !attempt?.rehearsal;

  const stepState = (key: keyof Phases): StepState => {
    if (measured) return isNum(phases?.[key]) ? 'done' : 'skipped';
    if (rehearsing) return 'live';
    if (neverRan) return 'skipped';
    return 'pending';
  };

  const total = phases?.total_ms;
  const barTotal = measured ? PHASES.reduce((sum, p) => sum + (phases?.[p.key] ?? 0), 0) : 0;

  return (
    <>
      <div className="rehearsal-head">
        <p className="rehearsal-sum">
          {measured && isNum(total) && (
            <>
              <strong className="mono rehearsal-total">{ms(total)}</strong> from boot to destroy, snapshot not included
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
      </div>

      <div className={rehearsing ? 'phasebar is-live' : 'phasebar'} role="img" aria-label={measured ? 'Share of rehearsal time per phase' : 'Rehearsal progress'}>
        {measured &&
          shown.map((p) => {
            const v = phases?.[p.key];
            if (!isNum(v) || !barTotal) return null;
            return <span key={p.key} className={p.key === 'execute_ms' ? 'seg-strong' : 'seg-plain'} style={{ flexGrow: v, flexBasis: 0 }} title={`${p.label}: ${ms(v)}`} />;
          })}
      </div>

      <ol className="phases" style={{ '--phases': shown.length + 1 } as CSSProperties}>
        <Step
          label="Snapshot"
          state={snap ? 'done' : run.status === 'snapshotting' ? 'live' : neverRan ? 'skipped' : 'pending'}
          value={snap ? ms(snap.detail?.ms) : undefined}
          note={snap ? (snap.detail?.cached ? 'cached' : 'new') : undefined}
        />
        {shown.map((p) => (
          <Step key={p.key} label={p.label} state={stepState(p.key)} value={measured && isNum(phases?.[p.key]) ? ms(phases?.[p.key]) : undefined} strong={p.key === 'execute_ms'} />
        ))}
      </ol>

      {run.prod_check && <ProdCheck check={run.prod_check} />}

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
