import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attempt, Run } from '../api/types';
import { STACKED, useMedia, useReducedMotion } from '../lib/media';
import { sourceLine } from '../ui/Figure';
import { ReplayControls, TwoRooms, TwoRoomsEmpty, useRehearsal } from '../ui/TwoRooms';
import { isHostReport, isSeeded, liveLines, networkNote, prodViewFor, roomsFromRun, roomsWhileLive } from './rooms';
import { isInProgress } from '../lib/status';

/** Nothing to draw, because no clone ever ran. It says why, and shows prod's hash only if it was measured. */
function NoClone({ run, attempt }: { run: Run; attempt: Attempt | null }) {
  const view = prodViewFor(run, 0);
  const why =
    attempt?.verdict === 'blocked_by_gate'
      ? 'The static gate refused this plan, so no clone was started.'
      : attempt?.verdict === 'invalid_plan'
        ? 'The agent produced no valid plan, so no clone was started.'
        : attempt?.verdict === 'sandbox_error'
          ? 'The sandbox failed, so nothing here was measured.'
          : attempt?.verdict === 'sql_error'
            ? 'The plan failed on the clone, so its transaction never finished and nothing was counted.'
            : 'No clone ran for this attempt.';
  return (
    <TwoRoomsEmpty
      loading={false}
      clone={
        <div className="rooms-notyet">
          <div className="t-display-m">No measurement</div>
          <p>{why}</p>
        </div>
      }
      prod={
        <div className="rooms-notyet">
          <div className={`t-display-m prod-same is-${view.tone}`}>Prod: {view.word}</div>
          {view.hashes.some((h) => h.value) && (
            <dl className="run-rooms-hashes">
              {view.hashes.map((h) =>
                h.value ? (
                  <div key={h.label}>
                    <dt>{h.label}</dt>
                    <dd>{h.value.slice(0, 12)}…</dd>
                  </div>
                ) : null,
              )}
            </dl>
          )}
          <p>{view.note}</p>
        </div>
      }
    />
  );
}

/** The same two rooms as the landing page, bound to this run. Polling hands over new objects every few seconds, so the
 *  data is keyed on what actually changes: otherwise the replay would restart with every poll. */
export function RunRooms({ run, attempt, picked }: { run: Run; attempt: Attempt | null; picked: number | null }) {
  const reduced = useReducedMotion();
  const stacked = useMedia(STACKED);
  const inProgress = isInProgress(run.status);
  const hasReport = !!attempt?.report;
  const live = inProgress && !hasReport;

  // Watched it finish, or asked for another attempt: play it. Opened a finished run: the end state, with Replay a click away.
  const watched = useRef(inProgress);
  if (inProgress) watched.current = true;

  const key = `${run.id}|${attempt?.n ?? ''}|${attempt?.report_hash ?? attempt?.plan_hash ?? ''}|${hasReport}|${Object.keys(run.snapshot?.tables ?? {}).length}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shape = useMemo(() => (live ? roomsWhileLive(run) : roomsFromRun(run, attempt)), [key, live]);
  const control = useRehearsal(shape, { reduced, autoPlay: watched.current || picked !== null, hold: live, startDelay: 200 });

  // The one time prod moves: a real apply finishing while this page is open.
  const [moved, setMoved] = useState(0);
  const lastStatus = useRef(run.status);
  useEffect(() => {
    const was = lastStatus.current;
    lastStatus.current = run.status;
    if ((was === 'approved' || was === 'applying') && ['applied', 'rolled_back', 'drift_detected'].includes(run.status)) setMoved((m) => m + 1);
  }, [run.status]);

  const [scale, setScale] = useState<string | null>(null);
  const onScale = useCallback((s: string) => setScale(s), []);
  const prod = prodViewFor(run, moved);
  const stateLive = live ? liveLines(run) : null;
  const unit = isHostReport(attempt) ? 'files' : 'rows';
  const factor = control.script?.factor ?? 1;
  const dots = Object.keys(shape?.snapshot_rows ?? {}).length > 0;

  if (!live && !shape) {
    return (
      <div className="run-rooms is-empty">
        <NoClone run={run} attempt={attempt} />
      </div>
    );
  }
  return (
    <figure className="run-rooms">
      <div className="run-rooms-stage">
        {shape && <TwoRooms control={control} hero={shape} phone={stacked} seeded={isSeeded(run)} unit={unit} prod={prod} live={stateLive} network={networkNote(attempt)} sourceLine={onScale} />}
      </div>
      <figcaption className="run-rooms-bar">
        <p className="t-caption">
          {sourceLine({ run: run.id, measured: run.created_at, scale: dots ? scale : null, extra: factor > 1 ? `compressed ×${factor.toFixed(1)}` : null })}
          {live ? ' · Live from this run. Dots wait until a measurement lands.' : ` · Phase lengths are measured. Order inside a phase follows ${unit === 'files' ? 'the directory list' : 'the foreign keys'}, not a clock.`}
          {!live && (run.attempts?.length ?? 0) > 1 && attempt ? ` Showing attempt ${attempt.n}.` : ''}
        </p>
        {!live && (
          <div className="run-rooms-controls">
            <ReplayControls control={control} reduced={reduced} />
          </div>
        )}
      </figcaption>
    </figure>
  );
}
