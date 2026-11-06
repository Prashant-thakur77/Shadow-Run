import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError, api, errorText } from '../api/client';
import type { RunSummary, Target } from '../api/types';
import { MISSING, num, ms, short, usd, when } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { isInProgress, statusInfo } from '../lib/status';
import { orderTargets, showTarget, targetLabel } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { Loading, Mark, Notice } from '../ui/bits';

const EXAMPLES = {
  postgres: {
    tasks: [
      'Archive users who have been inactive for over a year. They should be removed from the users table.',
      'Purge expired sessions older than 30 days',
      'Drop the temp table orders_tmp',
      'Mark trial users as expired',
    ],
    plans: [
      { label: 'Delete inactive users, the naive way', code: "DELETE FROM users WHERE last_login_at < now() - interval '1 year'" },
      { label: 'Suspend long-gone users', code: "UPDATE users SET status = 'suspended' WHERE last_login_at < now() - interval '2 years'" },
      { label: 'Flip one feature flag', code: "UPDATE feature_flags SET enabled = true WHERE key = 'beta_search'" },
      { label: 'Try to escape the transaction', code: 'COMMIT; DROP TABLE orders CASCADE' },
    ],
    pipeline: [
      'The plan is frozen and hashed.',
      'It runs on a disposable clone of prod, in a microVM with no network.',
      'Postgres measures the real blast radius, cascades included.',
      'Frozen guardrails are checked. The agent cannot edit them.',
      'If it is over budget, a different person approves the exact hashes.',
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
      'If it is over budget, a different person approves the exact hashes.',
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

  const [mode, setMode] = useState<Mode>('task');
  const [task, setTask] = useState('');
  const [plan, setPlan] = useState('');
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
        <form className="taskbox" onSubmit={start}>
          {list.length > 1 && (
            <div className="target-pick target-pick-home">
              <span className="label">Target</span>
              <div className="seg" role="group" aria-label="Target">
                {list.map((t) => (
                  <button key={t.id} type="button" className={t.id === target?.id ? 'seg-btn is-on' : 'seg-btn'} aria-pressed={t.id === target?.id} onClick={() => pick(t.id)}>
                    {targetLabel(t)}
                  </button>
                ))}
              </div>
              <span className="muted target-pick-name">{target?.name}</span>
            </div>
          )}
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

          <div className="taskbox-foot">
            <button className="btn btn-primary btn-large" type="submit" disabled={busy}>
              {busy ? 'Starting' : 'Rehearse on a clone'}
            </button>
            <span className="muted taskbox-hint">Nothing touches prod until it has been rehearsed.</span>
          </div>
          {error && (
            <p className="error-line" role="alert">
              {error}
            </p>
          )}

          <div className="examples">
            <h2 className="examples-title">{mode === 'task' ? 'Examples' : 'Example plans'}</h2>
            {mode === 'task' ? (
              <ul className="example-list">
                {examples.tasks.map((t) => (
                  <li key={t}>
                    <button type="button" className={task === t ? 'example is-on' : 'example'} onClick={() => setTask(t)}>
                      {t}
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
          <h2 className="pipeline-title">What happens to a plan</h2>
          <ol className="pipeline-list">
            {examples.pipeline.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ol>
        </aside>
      </div>

      <RecentRuns kinds={Object.fromEntries(list.map((t) => [t.id, t.kind]))} />
    </div>
  );
}

function RecentRuns({ kinds }: { kinds: Record<string, string | undefined> }) {
  const runs = useAsync<RunSummary[]>(() => api.runs(15));
  const anyLive = (runs.data ?? []).some((r) => isInProgress(r.status));

  useEffect(() => {
    if (!anyLive) return;
    const t = window.setTimeout(runs.reload, 3000);
    return () => window.clearTimeout(t);
  }, [anyLive, runs.data, runs.reload]);

  return (
    <section className="recent" aria-labelledby="recent-title">
      <h2 className="recent-title" id="recent-title">
        Recent runs
      </h2>
      {runs.error && <Notice tone="bad" title="Could not load runs.">{runs.error}</Notice>}
      {!runs.data && !runs.error && <Loading />}
      {runs.data && runs.data.length === 0 && <p className="muted">No runs yet.</p>}
      {runs.data && runs.data.length > 0 && (
        <div className="runlist">
          <div className="runlist-head" aria-hidden="true">
            <span>Status</span>
            <span>Task or plan</span>
            <span>By</span>
            <span>Started</span>
            <span className="num">Rows changed</span>
            <span className="num">Via cascade</span>
            <span className="num">Guardrails failed</span>
            <span className="num">Rehearsal</span>
            <span className="num">Cost</span>
          </div>
          {runs.data.map((r) => (
            <RunRow key={r.id} run={r} isHost={kinds[r.target_id ?? ''] === 'host'} />
          ))}
        </div>
      )}
    </section>
  );
}

function RunRow({ run, isHost }: { run: RunSummary; isHost: boolean }) {
  const info = statusInfo(run.status);
  const attempts = run.attempts ?? 0;
  return (
    <Link href={`/runs/${encodeURIComponent(run.id)}`} className="runrow">
      <span className={`runrow-status tone-${info.tone}`}>
        <Mark tone={info.tone} size={13} />
        {info.label}
      </span>
      <span className="runrow-task">
        {run.task ? (
          <span className="runrow-tasktext">{run.task}</span>
        ) : (
          <span className="runrow-tasktext">
            {run.plan_preview ? <code className="mono">{run.plan_preview}</code> : <>{isHost ? 'Shell plan' : 'SQL plan'} <code className="mono muted">{short(run.plan_hash, 10)}</code></>}
          </span>
        )}
        {attempts > 1 && <span className="muted runrow-attempts">{attempts} attempts</span>}
      </span>
      <span className="runrow-cell mono" data-label="By">{run.requester ?? MISSING}</span>
      <span className="runrow-cell mono" data-label="Started">{when(run.created_at)}</span>
      <span className="runrow-cell mono num" data-label={isHost ? 'Files changed' : 'Rows changed'}>{isHost ? (run.files_changed != null ? `${num(run.files_changed)} files` : MISSING) : num(run.rows_changed)}</span>
      <span className="runrow-cell mono num" data-label="Via cascade">{isHost ? MISSING : num(run.rows_via_cascade)}</span>
      <span className="runrow-cell mono num" data-label="Guardrails failed">{num(run.guardrails_failed)}</span>
      <span className="runrow-cell mono num" data-label="Rehearsal">{ms(run.rehearsal_ms)}</span>
      <span className="runrow-cell mono num" data-label="Cost">{usd(run.cost_usd)}</span>
    </Link>
  );
}
