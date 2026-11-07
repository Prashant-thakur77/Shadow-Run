import './_styles';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { ApiError, api, errorText } from '../api/client';
import type { RunFeed, RunSummary, Target } from '../api/types';
import { MISSING, num, ms, short, usd, when } from '../lib/format';
import { useReducedMotion } from '../lib/media';
import { myRuns } from '../lib/myRuns';
import { Link, navigate, useLocation } from '../lib/router';
import { isInProgress, runInfo } from '../lib/status';
import { orderTargets, showTarget, targetLabel } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { Loading, Mark, Notice } from '../ui/bits';
import { Frame } from '../ui/Frame';
import { PrimaryButton } from '../ui/Halftone';
import { Label } from '../ui/Label';
import { handOffRun } from '../run/handoff';

const EXAMPLES = {
  postgres: {
    tasks: [
      'Archive users who have been inactive for over a year. They should be removed from the users table.',
      'Purge expired sessions older than 30 days',
      'Drop the temp table orders_tmp',
      'Mark trial users as expired',
      'Account 8 is shrinking to just the owner. Remove everyone else from the account.',
    ],
    plans: [
      { label: 'Delete inactive users, the naive way', code: "DELETE FROM users WHERE last_login_at < now() - interval '1 year'" },
      { label: 'Suspend long-gone users', code: "UPDATE users SET status = 'suspended' WHERE last_login_at < now() - interval '2 years'" },
      { label: "Edit one flag's note, which applies with no person", code: "UPDATE feature_flags SET note = 'Checked in review' WHERE key = 'beta_search'" },
      { label: 'Flip one feature flag, which waits for a person', code: "UPDATE feature_flags SET enabled = true WHERE key = 'beta_search'" },
      { label: 'Try to escape the transaction', code: 'COMMIT; DROP TABLE orders CASCADE' },
    ],
    pipeline: [
      'The plan is frozen and hashed.',
      'It runs on a disposable clone of prod, in a microVM with no network.',
      'Postgres measures the real blast radius, cascades included.',
      'Frozen guardrails are checked. The agent cannot edit them.',
      'Unless it stays on the list of what may change alone, a different person approves the exact hashes.',
      'The same plan runs on prod in one transaction. If counts differ from the rehearsal, it rolls back.',
    ],
  },
  host: {
    tasks: [
      'The disk on the app server is almost full and /var/app/cache is the biggest thing on it. Free up space there.',
      "Free up space in /var/app/logs, the log files are getting out of hand. Remove what's not needed.",
      "Clean up the old releases under /var/app/releases and then restart nginx, it's serving a stale page.",
      'Delete the old stuff under /var/app, anything not touched in the last 6 months should be fine to go.',
    ],
    plans: [
      { label: 'Delete the whole cache, the naive way', code: 'rm -rf /var/app/cache/*' },
      { label: 'Clear only thumbnails and temp files', code: 'rm -f /var/app/cache/tmp/*.tmp\n\nfind /var/app/cache/thumbs -type f -name "*.jpg" -delete' },
      { label: 'Delete by age alone', code: 'find /var/app -type f -mtime +180 -delete' },
      { label: 'Stop the web server', code: 'systemctl stop nginx' },
    ],
    pipeline: [
      'The plan is frozen and hashed.',
      'It runs on a disposable copy of the server, in a microVM behind a deny-all network policy.',
      'Every file and service the plan touched is measured.',
      'Frozen guardrails are checked. The agent cannot edit them.',
      'Unless it stays on the list of what may change alone, a different person approves the exact hashes.',
      'The same plan runs on the server. If files or services differ from the rehearsal, the server is restored.',
    ],
  },
};

type Mode = 'task' | 'plan';

export function HomePage() {
  const targets = useAsync<Target[]>(() => api.targets());
  const list = useMemo(() => orderTargets(targets.data ?? []), [targets.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const target = list.find((t) => t.id === picked) ?? list[0];
  const isHost = target?.kind === 'host';
  const examples = isHost ? EXAMPLES.host : EXAMPLES.postgres;
  const planWord = isHost ? 'shell' : 'SQL';

  // A link can arrive with a task already written, such as the ones a read-only run suggests.
  const { search } = useLocation();
  const prefill = useMemo(() => new URLSearchParams(search), [search]);
  const [mode, setMode] = useState<Mode>(prefill.get('plan') ? 'plan' : 'task');
  const [task, setTask] = useState(prefill.get('task') ?? '');
  const [plan, setPlan] = useState(prefill.get('plan') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    showTarget(target?.id);
  }, [target?.id]);

  const pick = (id: string) => {
    setPicked(id);
    // A plan written for one target means nothing on the other.
    setTask('');
    setPlan('');
    setError(null);
  };

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const stepType: 'sql' | 'shell' = isHost ? 'shell' : 'sql';
    const body =
      mode === 'task'
        ? { task: task.trim() }
        : {
            // Steps are split on blank lines only. Splitting on semicolons would break string literals,
            // and the gate has to see what was actually pasted.
            steps: plan
              .split(/\n\s*\n/)
              .map((s) => s.trim())
              .filter(Boolean)
              .map((cmd) => ({ type: stepType, cmd })),
          };
    if ('task' in body ? !body.task : !body.steps?.length) {
      setError(mode === 'task' ? 'Describe a task first.' : `Paste a ${planWord} plan first.`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.startRun({ ...body, target_id: target?.id });
      handOffRun(res.id, mode === 'task' ? task.trim() : plan.trim(), mode === 'plan');
      navigate(`/runs/${encodeURIComponent(res.id)}`);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 429) setError(`Rate limit: ${err.message}`);
      else setError(errorText(err));
    }
  };

  return (
    <div className="page home">
      <div className="home-grid">
        <form className={busy ? 'taskbox is-sending' : 'taskbox'} onSubmit={start}>
          <div className="taskbox-top">
            <Label>New task</Label>
            {list.length > 1 && (
              <div className="target-pick-home">
                <span className="target-pick-name">{target?.name}</span>
                <div className="seg" role="group" aria-label="Target">
                  {list.map((t) => (
                    <button key={t.id} type="button" className={t.id === target?.id ? 'seg-btn is-on' : 'seg-btn'} aria-pressed={t.id === target?.id} onClick={() => pick(t.id)}>
                      {targetLabel(t)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="taskbox-head">
            <h1 className="taskbox-title">{mode === 'task' ? 'Give the agent a task' : `Paste a ${planWord} plan`}</h1>
            <div className="seg" role="group" aria-label="Input type">
              <button type="button" className={mode === 'task' ? 'seg-btn is-on' : 'seg-btn'} aria-pressed={mode === 'task'} onClick={() => setMode('task')}>
                Task
              </button>
              <button type="button" className={mode === 'plan' ? 'seg-btn is-on' : 'seg-btn'} aria-pressed={mode === 'plan'} onClick={() => setMode('plan')}>
                {isHost ? 'Shell plan' : 'SQL plan'}
              </button>
            </div>
          </div>

          <Frame className="taskbox-frame">
          {mode === 'task' ? (
            <textarea
              className="taskbox-input"
              aria-label="Task for the agent"
              rows={4}
              maxLength={2000}
              placeholder="What should change in prod? Plain English."
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
          ) : (
            <textarea
              className="taskbox-input taskbox-input-sql"
              aria-label={`${planWord} plan`}
              rows={6}
              spellCheck={false}
              placeholder={'One step, or several separated by a blank line.\nThe agent is skipped. The plan goes straight to the gate and the clone.'}
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
            />
          )}
          </Frame>

          <div className="taskbox-foot">
            <PrimaryButton className="btn-large" type="submit" disabled={busy}>
              {busy ? 'Starting' : 'Rehearse on a clone'}
            </PrimaryButton>
            <span className="muted taskbox-hint">Nothing touches prod until it has been rehearsed.</span>
          </div>
          {error && (
            <p className="error-line" role="alert">
              {error}
            </p>
          )}

          <div className="examples">
            <h2 className="examples-title t-label">{mode === 'task' ? 'Examples' : 'Example plans'}</h2>
            {mode === 'task' ? (
              <ul className="example-list">
                {examples.tasks.map((t) => (
                  <li key={t}>
                    <button type="button" className={task === t ? 'example is-on' : 'example'} onClick={() => setTask(t)}>
                      <span className="example-text">{t}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="example-list">
                {examples.plans.map((p) => (
                  <li key={p.label}>
                    <button type="button" className={plan === p.code ? 'example is-on' : 'example'} onClick={() => setPlan(p.code)}>
                      <span>{p.label}</span>
                      <code className="example-sql mono">{p.code}</code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </form>

        <aside className="pipeline" aria-label="What happens to a plan">
          <h2 className="pipeline-title t-label">What happens to a plan</h2>
          <ol className="pipeline-list">
            {examples.pipeline.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        </aside>
      </div>

      <StartHere targetId={list.find((t) => t.kind !== 'host')?.id} onError={setError} />

      <RecentRuns kinds={Object.fromEntries(list.map((t) => [t.id, t.kind]))} />
    </div>
  );
}

const TRAP_TASK = EXAMPLES.postgres.tasks[0];
// Too big for the auto-apply list, so it waits for a person, and it touches users, so the drift controls work on it too.
// A plan needs no model, so this starts fast and spends nothing. Old runs won't do: their approval window has closed.
const BREAK_PLAN = EXAMPLES.postgres.plans[1].code;

function StartHere({ targetId, onError }: { targetId?: string; onError: (message: string | null) => void }) {
  const [busy, setBusy] = useState<'trap' | 'break' | null>(null);
  const begin = async (which: 'trap' | 'break') => {
    setBusy(which);
    onError(null);
    try {
      if (which === 'trap') {
        const res = await api.startRun({ task: TRAP_TASK, target_id: targetId });
        navigate(`/runs/${encodeURIComponent(res.id)}`);
      } else {
        const res = await api.startRun({ steps: [{ type: 'sql', cmd: BREAK_PLAN }], target_id: targetId });
        navigate(`/runs/${encodeURIComponent(res.id)}#break`);
      }
    } catch (e) {
      setBusy(null);
      onError(errorText(e));
    }
  };
  return (
    <section className="starthere" aria-labelledby="starthere-title">
      <h2 className="starthere-title t-label" id="starthere-title">
        Start here
      </h2>
      <ol className="starthere-list">
        <li>
          <Link href="/race" className="startitem">
            <span className="startitem-title">Race the agent</span>
            <span className="startitem-line">One task, two runs at once: the agent alone, and through Shadow Run. See the numbers side by side.</span>
          </Link>
        </li>
        <li>
          <button type="button" className="startitem" disabled={!!busy} onClick={() => void begin('trap')}>
            <span className="startitem-title">{busy === 'trap' ? 'Starting the trap task' : 'Run the trap task'}</span>
            <span className="startitem-line">Ask the agent to archive inactive users. A foreign-key cascade is waiting.</span>
          </button>
        </li>
        <li>
          <button type="button" className="startitem" disabled={!!busy} onClick={() => void begin('break')}>
            <span className="startitem-title">{busy === 'break' ? 'Starting a run to attack' : 'Try to break it'}</span>
            <span className="startitem-line">Approve your own change or tamper with a hash. The server answers with a real 403 or 409.</span>
          </button>
        </li>
        <li>
          <Link href="/incidents" className="startitem">
            <span className="startitem-title">Replay a real incident</span>
            <span className="startitem-line">Commands that wrecked real systems, run on a clone instead.</span>
          </Link>
        </li>
        <li>
          <Link href="/redteam" className="startitem">
            <span className="startitem-title">Run the red team</span>
            <span className="startitem-line">Attacks run for real inside the microVM. Prod's hash is checked from outside.</span>
          </Link>
        </li>
        <li>
          <Link href="/guardrails#gauntlet" className="startitem">
            <span className="startitem-title">Attack the guardrails</span>
            <span className="startitem-line">A model tries to do damage while passing every rule.</span>
          </Link>
        </li>
      </ol>
    </section>
  );
}

const RECENT_FETCH = 60;
const RECENT_SHOWN = 15;

/** By default this browser's own runs and a few finished examples. Everyone on the demo shares one list, and strangers' text
 *  and stale approvals are not the first thing a new visitor should meet, so the rest is one click away. */
function RecentRuns({ kinds }: { kinds: Record<string, string | undefined> }) {
  const [showAll, setShowAll] = useState(false);
  const feed = useAsync<RunFeed>(() => api.runFeed(myRuns()));
  const everyone = useAsync<RunSummary[] | null>(() => (showAll ? api.runs(RECENT_FETCH) : Promise.resolve(null)), [showAll]);
  const runs = showAll ? everyone : feed;
  const mine = feed.data?.mine ?? [];
  const examples = feed.data?.examples ?? [];
  const all = everyone.data ?? [];
  const anyLive = (showAll ? all : mine).some((r) => isInProgress(r.status));
  const reload = showAll ? everyone.reload : feed.reload;

  useEffect(() => {
    if (!anyLive) return;
    const t = window.setTimeout(reload, 3000);
    return () => window.clearTimeout(t);
  }, [anyLive, reload, feed.data, everyone.data]);

  const shown = showAll ? all.slice(0, RECENT_FETCH) : [...mine.slice(0, RECENT_SHOWN), ...examples];
  // One log scale for every bar in the list, so rows can be compared at a glance.
  const scaleMax = Math.max(1, ...shown.map((r) => r.rows_changed ?? 0));
  // Rows may fade in on first load. Polling afterwards must not trigger anything.
  const reduced = useReducedMotion();
  const settled = useRef(false);
  useEffect(() => {
    if (runs.data) settled.current = true;
  }, [runs.data]);

  return (
    <section className="recent" aria-labelledby="recent-title">
      <div className="recent-head">
        <h2 className="recent-title t-label" id="recent-title">
          {showAll ? 'All recent runs' : 'Your runs and a few examples'}
        </h2>
        <button type="button" className="textbtn" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show only mine and the examples' : 'Show all'}
        </button>
      </div>
      <p className="muted recent-note">{showAll ? 'Everyone on this demo shares one prod and this list, so these include other visitors, scripts and tests.' : 'Everyone on this demo shares one prod. This list keeps to the runs from this browser, and examples of each way a run can end.'}</p>
      {runs.error && <Notice tone="bad" title="Could not load runs.">{runs.error}</Notice>}
      {!runs.data && !runs.error && <Loading />}
      {runs.data && shown.length === 0 && <p className="muted">{showAll ? 'No runs yet.' : 'No runs from this browser yet. Start one above.'}</p>}
      {shown.length > 0 && (
        <div className="runlist">
          {shown.map((r, i) => (
            <RunRow key={r.id} run={r} isHost={kinds[r.target_id ?? ''] === 'host'} index={i} scaleMax={scaleMax} animate={!settled.current && !reduced} />
          ))}
        </div>
      )}
    </section>
  );
}

function age(t: number | undefined): string {
  if (typeof t !== 'number') return MISSING;
  const seconds = Math.max(0, Date.now() / 1000 - t);
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function RunRow({ run, isHost, index, scaleMax, animate }: { run: RunSummary; isHost: boolean; index: number; scaleMax: number; animate: boolean }) {
  const info = runInfo(run);
  const attempts = run.attempts ?? 0;
  const rows = run.rows_changed;
  const share = typeof rows === 'number' && rows > 0 ? Math.log10(rows + 1) / Math.log10(scaleMax + 1) : 0;
  const meta = [
    run.example ? `Example. ${run.example}` : null,
    run.race_lane === 'alone' ? 'left lane of a race' : run.race_lane === 'through' ? 'right lane of a race' : null,
    run.requester ?? MISSING,
    when(run.created_at),
    !isHost && run.rows_via_cascade ? `${num(run.rows_via_cascade)} via cascade` : null,
    run.guardrails_failed ? `${num(run.guardrails_failed)} guardrails failed` : null,
    run.rehearsal_ms != null ? ms(run.rehearsal_ms) : null,
    run.cost_usd != null ? usd(run.cost_usd) : null,
    attempts > 1 ? `${attempts} attempts` : null,
  ].filter(Boolean);
  return (
    <Link href={`/runs/${encodeURIComponent(run.id)}`} className="runrow" style={{ '--row': index, animation: animate ? undefined : 'none' } as CSSProperties}>
      <span className={`runrow-status tone-${info.tone}`}>
        <Mark tone={info.tone} size={13} />
        {info.label}
      </span>
      <span className="runrow-main">
        <span className="runrow-tasktext">
          {run.task ? run.task : run.plan_preview ? <code className="mono">{run.plan_preview}</code> : <>{isHost ? 'Shell plan' : 'SQL plan'}</>}
        </span>
        <span className="runrow-meta">{meta.join(' · ')}</span>
      </span>
      <span className="runrow-rows">
        {isHost ? (
          <>
            <span />
            <span>{run.files_changed != null ? `${num(run.files_changed)} files` : MISSING}</span>
          </>
        ) : (
          <>
            <span className="runrow-bar" aria-hidden="true">
              <i style={{ width: `${(share * 100).toFixed(1)}%` }} />
            </span>
            <span>
              {num(rows)}
              <span className="sr-only"> rows changed</span>
            </span>
          </>
        )}
      </span>
      <code className="runrow-hash">{short(run.plan_hash, 10)}</code>
      <span className="runrow-age" title={when(run.created_at)}>
        {age(run.created_at)}
      </span>
    </Link>
  );
}
