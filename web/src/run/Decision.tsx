import { useEffect, useState } from 'react';
import { ApiError, api, errorText, notifyProdChanged } from '../api/client';
import type { Counts, FileCounts, Run } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { bytes, clockTime, ms, num, short, when } from '../lib/format';
import { Link, navigate } from '../lib/router';
import { Hash, Mark, Notice, Tag } from '../ui/bits';
import { changedToPass, isReadOnly, narrowedRows, undoOnOffer } from './derive';
import { hashMovedSinceRehearsal, measureProdBeforeApply } from './ProdProof';
import { EvadedNotice, evadedAttempt, PassedAfterBreaking } from './Evaded';
import { RefusedNotice } from './Refused';
import { canTakeToProd, ToProdButton } from './ToProd';
import { UndoPanel } from './Undo';

function HashRow({ label, value, locked, index }: { label: string; value?: string | null; locked?: boolean; index: number }) {
  return (
    <div className="hashrow" style={{ '--i': index } as React.CSSProperties}>
      <dt>
        {locked && (
          <svg className="hash-lock" width="10" height="11" viewBox="0 0 10 11" role="img" aria-label="locked">
            <path d="M2.5 4.5V3a2.5 2.5 0 0 1 5 0v1.5" fill="none" stroke="currentColor" />
            <rect x="1" y="4.5" width="8" height="6" fill="currentColor" />
          </svg>
        )}
        {label}
      </dt>
      <dd>
        <Hash value={value} full />
      </dd>
    </div>
  );
}

/** Once approved, each hash gets a lock in turn. */
function ThreeHashes({ plan, guardrails, report, locked }: { plan?: string | null; guardrails?: string | null; report?: string | null; locked?: boolean }) {
  return (
    <dl className="hashrows">
      <HashRow label="Plan" value={plan} locked={locked} index={0} />
      <HashRow label="Guardrails" value={guardrails} locked={locked} index={1} />
      <HashRow label="Report" value={report} locked={locked} index={2} />
    </dl>
  );
}

function ApprovePanel({ run, setRun }: { run: Run; setRun: (r: Run) => void }) {
  const c = run.challenge;
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const approve = async () => {
    if (!c) return;
    setBusy('approve');
    setError(null);
    try {
      setRun(await api.approve(run.id, c));
    } catch (e) {
      // The window closed while this page was open, so the page should say Expired, not just show an error.
      if (e instanceof ApiError && e.status === 410) setRun(await api.run(run.id));
      else setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy('reject');
    setError(null);
    try {
      setRun(await api.reject(run.id, reason));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="decide">
      <h3 className="decide-title">Your decision</h3>
      <p>You are approving these exact hashes. If any of them differs when this reaches the server, the approval is refused.</p>
      <ThreeHashes plan={c?.plan_hash} guardrails={c?.guardrails_hash} report={c?.report_hash} />
      {c?.expires_at !== undefined && <p className="muted">The approval window closes on <span className="mono">{when(c.expires_at)}</span>.</p>}
      <div className="decide-actions">
        <button type="button" className="btn btn-primary btn-large" disabled={!!busy || !c} onClick={approve}>
          {busy === 'approve' ? 'Approving' : 'Approve'}
        </button>
        {!rejecting ? (
          <button type="button" className="btn btn-large" disabled={!!busy} onClick={() => setRejecting(true)}>
            Reject
          </button>
        ) : (
          <span className="reject-form">
            <input className="input" aria-label="Reason for rejecting" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn" disabled={!!busy} onClick={reject}>
              {busy === 'reject' ? 'Rejecting' : 'Reject this run'}
            </button>
          </span>
        )}
      </div>
      {error && <p className="error-line" role="alert">{error}</p>}
    </div>
  );
}

function RequesterPanel({ run }: { run: Run }) {
  const { switchTo } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const c = run.challenge;
  const other = run.requester === 'reviewer' ? 'judge' : 'reviewer';
  return (
    <div className="decide">
      <h3 className="decide-title">{run.can?.approve_blocked_reason ?? 'A different person has to approve this.'}</h3>
      <ThreeHashes plan={c?.plan_hash} guardrails={c?.guardrails_hash} report={c?.report_hash} />
      <div className="decide-actions">
        <button
          type="button"
          className="btn btn-primary btn-large"
          onClick={() => {
            setError(null);
            switchTo(other).catch((e) => setError(errorText(e)));
          }}
        >
          Switch to {other}
        </button>
      </div>
      {error && <p className="error-line" role="alert">{error}</p>}
    </div>
  );
}

function ApplyPanel({ run, setRun, pollFast }: { run: Run; setRun: (r: Run) => void; pollFast: (on: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = run.approval;

  const apply = async () => {
    setBusy(true);
    setError(null);
    pollFast(true);
    try {
      await measureProdBeforeApply(run);
      setRun(await api.apply(run.id));
      notifyProdChanged();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    } finally {
      pollFast(false);
    }
  };

  return (
    <div className="decide">
      <h3 className="decide-title">
        Approved by <span className="mono">{a?.approver_id ?? 'unknown'}</span> at <span className="mono">{clockTime(a?.granted_at)}</span>
      </h3>
      <p>
        {run.final?.report?.kind === 'host'
          ? 'Applying runs this same hashed plan on the server. A filesystem has no transactions, so a state archive is kept, and the server is restored if files or services differ from the rehearsal. The approval works once.'
          : 'Applying runs this same hashed plan on prod in one transaction. If the counts differ from the rehearsal, the transaction rolls back. The approval works once.'}
      </p>
      <ThreeHashes plan={a?.plan_hash} guardrails={a?.guardrails_hash} report={a?.report_hash} locked />
      {a?.signature && (
        <p className="muted">
          Signature <Hash value={a.signature} chars={16} />
        </p>
      )}
      <div className="decide-actions">
        {run.can?.apply ? (
          <button type="button" className="btn btn-primary btn-large" disabled={busy} onClick={apply}>
            {busy ? 'Applying' : 'Apply to prod'}
          </button>
        ) : (
          <p className="muted">The server says this account can't apply this run.</p>
        )}
      </div>
      {error && <p className="error-line" role="alert">{error}</p>}
    </div>
  );
}

/** Counts for one table. Pass `against` to pick out the numbers that differ. */
function CountCell({ c, against }: { c?: Counts; against?: Counts }) {
  if (!c) return <span className="muted">none</span>;
  const part = (v: number | undefined, other: number | undefined, label: string) => {
    const differs = against && v !== other;
    return (
      <span className={differs ? 'count-diff' : undefined}>
        {num(v)} {label}
      </span>
    );
  };
  return (
    <span className="mono">
      {part(c.del, against?.del, 'del')}, {part(c.upd, against?.upd, 'upd')}, {part(c.ins, against?.ins, 'ins')}
    </span>
  );
}

function FileCountsTable({ expected, actual, actualLabel }: { expected?: FileCounts | null; actual?: FileCounts | null; actualLabel: string }) {
  const rows: [string, keyof FileCounts][] = [
    ['Files created', 'created'],
    ['Files deleted', 'deleted'],
    ['Files changed', 'changed'],
  ];
  return (
    <div className="scroll-x">
      <table className="data data-tight">
        <thead>
          <tr>
            <th scope="col"></th>
            <th scope="col" className="num">Rehearsal</th>
            <th scope="col" className="num">{actualLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, key]) => (
            <tr key={key}>
              <th scope="row">{label}</th>
              <td className="mono num">{num(expected?.[key])}</td>
              <td className="mono num">
                <span className={actual && expected?.[key] !== actual[key] ? 'count-diff' : undefined}>{num(actual?.[key])}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RehearseAgain({ run }: { run: Run }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!run.can?.rehearse_again) return null;
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.rehearseAgain(run.id);
      navigate(`/runs/${encodeURIComponent(res.id)}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="decide-actions" id="rehearse-again">
      <button type="button" className="btn btn-primary btn-large" disabled={busy} onClick={go}>
        {busy ? 'Starting' : 'Rehearse again'}
      </button>
      <span className="muted">Same plan, new snapshot, new rehearsal. Nothing carries over.</span>
      {error && <p className="error-line" role="alert">{error}</p>}
    </div>
  );
}

/** A window that closed. The plan may still be fine, but what was measured may no longer describe prod. */
function ExpiredPanel({ run }: { run: Run }) {
  return (
    <div className="decide">
      <h3 className="decide-title">The approval window closed on <span className="mono">{when(run.approval_expires_at)}</span>.</h3>
      <p>Nothing reached prod. An approval only holds for a short time, because prod can change after a rehearsal. Rehearsing again runs the same plan on a new snapshot, and a different person approves that.</p>
      <RehearseAgain run={run} />
    </div>
  );
}

/** Shadow Run says what a change would do, so a plan that only reads has nothing to report. It also has no rows to show: they stay in the clone. */
function ReadOnlyPanel() {
  return (
    <Notice tone="neutral" title="Nothing changed, because this plan only reads.">
      <span className="narrowed-line">Shadow Run is for changes. It measures what a plan would do to prod, and it does not return what a query finds. The rows stayed in the clone, and the clone is gone.</span>
      <span className="narrowed-line">
        Try a change: <Link href={`/?task=${encodeURIComponent('Mark trial users as expired')}`}>mark trial users as expired</Link>, <Link href={`/?task=${encodeURIComponent('Purge expired sessions older than 30 days')}`}>purge expired sessions</Link>, or <Link href="/race">race the agent</Link>.
      </span>
    </Notice>
  );
}

function ProofOfApply({ run }: { run: Run }) {
  const b = run.backup;
  const e = run.evidence;
  return (
    <dl className="kvs proof">
      {run.prod_after && (
        <div className="kv">
          <dt>Prod checksum afterwards</dt>
          <dd>{run.prod_after.startsWith('unavailable') ? <span className="mono">{run.prod_after}</span> : <Hash value={run.prod_after} chars={24} />}</dd>
        </div>
      )}
      {b && (
        <div className="kv">
          <dt>Backup before apply</dt>
          <dd className="mono proof-path">
            {b.error ?? (
              <>
                {[b.bucket, b.key].filter(Boolean).join('/') || b.path || 'stored'}, {bytes(b.bytes)}, {b.store}
              </>
            )}
          </dd>
        </div>
      )}
      {e && (
        <div className="kv">
          <dt>Evidence</dt>
          <dd className="proof-path">
            {e.error ? (
              <span className="mono">{e.error}</span>
            ) : (
              <>
                {run.evidence_url ? (
                  <a href={run.evidence_url} target="_blank" rel="noreferrer">
                    Open the evidence bundle
                  </a>
                ) : (
                  <a href={`/api/runs/${encodeURIComponent(run.id)}/evidence`} target="_blank" rel="noreferrer">
                    Open the evidence bundle
                  </a>
                )}{' '}
                <span className="muted">{bytes(e.bytes)}</span>
                <br />
                <Hash value={e.bundle_sha256} chars={24} />
              </>
            )}
          </dd>
        </div>
      )}
      {run.apply?.ms !== undefined && (
        <div className="kv">
          <dt>Apply took</dt>
          <dd className="mono">{ms(run.apply.ms)}</dd>
        </div>
      )}
    </dl>
  );
}

/** The header chip keeps showing the hash with the outside write in it. That is correct, so it gets explained here. */
function HashNote({ run }: { run: Run }) {
  if (!hashMovedSinceRehearsal(run) || run.apply?.restored === false) return null;
  return <p>Prod's hash differs from the rehearsal's because of a write from outside this run, not because of this plan. The Prod chip at the top includes that write{run.target_id?.startsWith('demo') ? ' until the demo is reseeded' : ''}.</p>;
}

function Outcome({ run }: { run: Run }) {
  const a = run.apply ?? {};
  const outcome = a.outcome ?? run.status;
  const isHost = run.final?.report?.kind === 'host';

  if (outcome === 'committed') {
    const tables = Object.keys(a.expected_counts ?? a.actual_counts ?? {});
    const guards = a.guardrails ?? [];
    const passed = guards.filter((g) => g.passed).length;
    return (
      <div className="outcome tone-good">
        <div className="outcome-word">
          <Mark tone="good" size={36} />
          Committed
        </div>
        <p className="outcome-line">{a.reason ?? 'Counts matched the rehearsal.'}</p>
        {run.approval?.kind === 'auto_budget' && (
          <p>
            Approved by <code className="mono">{run.approval.approver_id ?? 'budget policy'}</code>: the measured change stayed on the auto-apply list and inside the budget, so no person was needed.
          </p>
        )}
        {run.approval?.kind === 'human' && (
          <p>
            Approved by <code className="mono">{run.approval.approver_id}</code> at <span className="mono">{when(run.approval.granted_at)}</span>.
          </p>
        )}
        {isHost ? (
          <FileCountsTable expected={a.expected_files} actual={a.files} actualLabel="Server" />
        ) : (
        <div className="scroll-x">
          <table className="data data-tight">
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">Rehearsal</th>
                <th scope="col">Prod</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t}>
                  <th scope="row" className="mono">{t}</th>
                  <td><CountCell c={a.expected_counts?.[t]} /></td>
                  <td><CountCell c={a.actual_counts?.[t]} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        {guards.length > 0 && (
          <p>
            {isHost ? 'Guardrails on the server after the plan ran' : 'Guardrails on prod, inside the transaction'}: <span className="mono">{num(passed)} of {num(guards.length)}</span> passed.
            {a.schema_matches !== undefined && <> Schema {a.schema_matches ? 'matches' : 'differs'}.</>}
          </p>
        )}
        <ProofOfApply run={run} />
      </div>
    );
  }

  if (outcome === 'drift_detected') {
    return (
      <div className="outcome tone-caution">
        <div className="outcome-word">
          <Mark tone="caution" size={36} />
          Drift detected. Nothing was applied.
        </div>
        <p className="outcome-line">{a.reason}</p>
        <HashNote run={run} />
        {a.fingerprint_at_rehearsal && (
          <dl className="hashrows">
            <div className="hashrow">
              <dt>At rehearsal</dt>
              <dd><Hash value={a.fingerprint_at_rehearsal} full /></dd>
            </div>
            <div className="hashrow">
              <dt>Now</dt>
              <dd><Hash value={a.fingerprint_now} full /></dd>
            </div>
          </dl>
        )}
        {(a.drifted_tables?.length ?? 0) > 0 && (
        <div className="scroll-x">
          <table className="data data-tight">
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col" className="num">Rows at rehearsal</th>
                <th scope="col" className="num">Rows now</th>
                <th scope="col">MD5 at rehearsal</th>
                <th scope="col">MD5 now</th>
              </tr>
            </thead>
            <tbody>
              {(a.drifted_tables ?? []).map((d) => (
                <tr key={d.table}>
                  <th scope="row" className="mono">{d.table}</th>
                  <td className="mono num">{num(d.at_rehearsal?.rows)}</td>
                  <td className="mono num">{num(d.now?.rows)}</td>
                  <td className="mono nowrap">{String(d.at_rehearsal?.hash ?? "").slice(0, 12)}</td>
                  <td className="mono nowrap">{String(d.now?.hash ?? "").slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        <RehearseAgain run={run} />
        <ProofOfApply run={run} />
      </div>
    );
  }

  return (
    <div className="outcome tone-bad">
      <div className="outcome-word">
        <Mark tone="bad" size={36} />
        Rolled back
      </div>
      <p className="outcome-line">{a.reason}</p>
      <HashNote run={run} />
      {a.restored !== undefined && <p>{a.restored ? 'The server was restored from the state archive.' : 'The server could not be restored from the state archive.'}</p>}
      {isHost && a.files && <FileCountsTable expected={a.expected_files} actual={a.files} actualLabel="Actual" />}
      {(a.count_mismatches?.length ?? 0) > 0 && (
        <div className="scroll-x">
          <table className="data data-tight">
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">Rehearsal</th>
                <th scope="col">Actual</th>
              </tr>
            </thead>
            <tbody>
              {a.count_mismatches?.map((m) => (
                <tr key={m.table}>
                  <th scope="row" className="mono">{m.table}</th>
                  <td><CountCell c={m.rehearsal} against={m.actual} /></td>
                  <td><CountCell c={m.actual} against={m.rehearsal} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(a.content_mismatches?.length ?? 0) > 0 && (
        <div className="scroll-x">
          <p>Row counts can match while the rows themselves differ. Content hash of each table:</p>
          <table className="data data-tight">
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">Rows, rehearsal</th>
                <th scope="col">Rows, prod</th>
                <th scope="col">Hash, rehearsal</th>
                <th scope="col">Hash, prod</th>
              </tr>
            </thead>
            <tbody>
              {a.content_mismatches?.map((m) => (
                <tr key={m.table}>
                  <th scope="row" className="mono">{m.table}</th>
                  <td className="mono num">{m.rehearsal?.rows ?? '-'}</td>
                  <td className="mono num">{m.actual?.rows ?? '-'}</td>
                  <td className="mono nowrap">{String(m.rehearsal?.hash ?? '').slice(0, 14)}</td>
                  <td className="mono nowrap">{String(m.actual?.hash ?? '').slice(0, 14)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <RehearseAgain run={run} />
      <ProofOfApply run={run} />
    </div>
  );
}

/** The retry loop can narrow a request until it passes, so whoever decides is told when the plan shrank. */
/** A different model read the request against the final plan. Its doubt adds a person, and it never removes one. */
function SecondOpinionNotice({ run, origin }: { run: Run; origin?: Run | null }) {
  // A plan from a race was written, and read by the second model, in that race. Once a person has decided, the line that
  // helps them decide has done its job, and the doubt stays on the record.
  const opinion = (origin?.final ?? run.final)?.second_opinion;
  if (!opinion || opinion.error || !opinion.verdict || run.refused) return null;
  const because = run.status === 'awaiting_approval' && !run.expired ? changedToPass(origin?.attempts ?? run.attempts, origin?.final ?? run.final) : null;
  const said = [opinion.left_out, opinion.added].filter(Boolean);
  if (opinion.verdict === 'does_it') {
    return (
      <p className="muted">
        Second opinion from <code className="mono">{opinion.model}</code>: this does what was asked. It has no say over what is safe.
      </p>
    );
  }
  return (
    <Notice tone="caution" title={`A second model ${opinion.verdict === 'does_not' ? "doesn't think this does" : 'thinks this only partly does'} what you asked`}>
      {said.map((line) => (
        <span className="narrowed-line" key={line}>
          {line}
        </span>
      ))}
      {because && <span className="narrowed-line">{because}</span>}
      <span className="narrowed-line muted">
        From <code className="mono">{opinion.model}</code>, which didn't write the plan. Its doubt can add a person, and it can't remove one.
        {opinion.numbers_verified === false ? ' Some numbers it states are not in the measurements.' : ''}
      </span>
    </Notice>
  );
}

function NarrowedNotice({ run }: { run: Run }) {
  const rows = narrowedRows(run);
  if (!rows || run.refused || !['awaiting_approval', 'approved', 'applied', 'no_change'].includes(run.status)) return null;
  const done = run.status === 'applied';
  const summary = (run.final ?? run.attempts?.[run.attempts.length - 1])?.plan?.summary;
  return (
    <Notice
      tone="caution"
      title={`This ${done ? 'changed' : 'changes'} fewer rows than the agent's first plan (${num(rows.final)}, was ${num(rows.first)}). Check it still ${done ? 'did' : 'does'} what you asked.`}
    >
      {run.task && (
        <span className="narrowed-line">
          <span className="label">You asked</span> {run.task}
        </span>
      )}
      {summary && (
        <span className="narrowed-line">
          <span className="label">The agent's summary of this plan</span> {summary}
        </span>
      )}
    </Notice>
  );
}

function Badges({ run }: { run: Run }) {
  const again = run.final?.reproduced;
  if (!again) return null;
  return (
    <p className="decide-badges">
      <Tag tone={again.ok ? 'good' : 'bad'}>{again.ok ? 'Reproduced on a second clone' : 'Did not reproduce on a second clone'}</Tag>
      {!again.ok && (again.differs?.length ?? 0) > 0 && <span className="mono muted">{again.differs?.join(', ')}</span>}
    </p>
  );
}

/** Keeps the decision one move away while it's waiting: the three hashes and the one action. It steps aside while the
 *  decision itself is on screen, so nothing is offered twice. */
export function DecisionBar({ run, setRun, pollFast }: { run: Run; setRun: (r: Run) => void; pollFast: (on: boolean) => void }) {
  const { switchTo } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelInView, setPanelInView] = useState(false);
  // A race's runs can't be approved, so there's no decision to keep in reach. Past the decision, the next move still is:
  // an undo sits far down an applied run, and a stopped or expired one has to be rehearsed again.
  const waiting = ((run.status === 'awaiting_approval' && !run.expired) || run.status === 'approved') && !run.race;
  const after = !waiting && !run.race ? (undoOnOffer(run) ? 'undo' : run.can?.rehearse_again ? 'again' : null) : null;
  const watched = after === 'undo' ? 'undo-action' : after === 'again' ? 'rehearse-again' : 'decision';

  useEffect(() => {
    const el = document.getElementById(watched);
    setPanelInView(false);
    if (!el || (!waiting && !after)) return;
    const observer = new IntersectionObserver(([entry]) => setPanelInView(entry.isIntersecting), { threshold: waiting ? 0.25 : 0.9 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [waiting, after, watched, run.status]);

  if ((!waiting && !after) || panelInView) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (after) {
    const hash = run.prod_after && !run.prod_after.startsWith('unavailable') ? run.prod_after : null;
    return (
      <aside className="decisionbar" aria-label="The next step">
        <p className="decisionbar-state">
          {after === 'undo' ? 'On prod. You can undo it.' : run.expired ? 'The approval window closed.' : 'That approval is used up.'}
          {hash && (
            <>
              {' '}
              Prod <code className="mono">{short(hash, 8).replace('…', '')}</code>
            </>
          )}
        </p>
        {error && <p className="error-line decisionbar-error" role="alert">{error}</p>}
        <div className="decisionbar-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const res = after === 'undo' ? await api.undo(run.id) : await api.rehearseAgain(run.id);
                navigate(`/runs/${encodeURIComponent(res.id)}`);
              })
            }
          >
            {busy ? 'Starting' : after === 'undo' ? 'Undo this change' : 'Rehearse again'}
          </button>
          <a className="btn" href="#decision">
            {run.expired ? 'Read why' : 'Read the outcome'}
          </a>
        </div>
      </aside>
    );
  }

  const c = run.challenge;
  const a = run.approval;
  const other = run.requester === 'reviewer' ? 'judge' : 'reviewer';
  const hashes = run.status === 'approved' ? [a?.plan_hash, a?.guardrails_hash, a?.report_hash] : [c?.plan_hash, c?.guardrails_hash, c?.report_hash];

  return (
    <aside className="decisionbar" aria-label="The decision">
      <dl className="decisionbar-hashes">
        {['plan', 'guardrails', 'report'].map((label, i) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono">{short(hashes[i], 8).replace('…', '')}</dd>
          </div>
        ))}
      </dl>
      {error && <p className="error-line decisionbar-error" role="alert">{error}</p>}
      <div className="decisionbar-actions">
        {run.status === 'approved' ? (
          run.can?.apply ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  pollFast(true);
                  try {
                    await measureProdBeforeApply(run);
                    setRun(await api.apply(run.id));
                    notifyProdChanged();
                  } finally {
                    pollFast(false);
                  }
                })
              }
            >
              {busy ? 'Applying' : 'Apply this plan'}
            </button>
          ) : (
            <a className="btn" href="#decision">
              See why this account can't apply
            </a>
          )
        ) : run.can?.approve ? (
          <button type="button" className="btn btn-primary" disabled={busy || !c} onClick={() => void act(async () => c && setRun(await api.approve(run.id, c)))}>
            {busy ? 'Approving' : 'Approve these hashes'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => switchTo(other))}>
            Switch to {other}
          </button>
        )}
        {run.status === 'approved' ? (
          <a className="btn" href="#break">
            Try to break it first
          </a>
        ) : (
          <a className="btn" href="#decision">
            Read the decision
          </a>
        )}
      </div>
    </aside>
  );
}

export function DecisionSection({ run, origin, setRun, pollFast }: { run: Run; origin?: Run | null; setRun: (r: Run) => void; pollFast: (on: boolean) => void }) {
  // Undo is offered while a person decides, and after the change is on prod.
  const showUndo = ['awaiting_approval', 'approved', 'applied'].includes(run.status) && !run.expired;
  return (
    <>
      <Badges run={run} />
      <SecondOpinionNotice run={run} origin={origin} />
      {run.status === 'awaiting_approval' && !run.expired && <PassedAfterBreaking attempts={(origin ?? run).attempts} final={(origin ?? run).final} />}
      <NarrowedNotice run={run} />
      <DecisionPanel run={run} setRun={setRun} pollFast={pollFast} />
      {showUndo && <UndoPanel run={run} />}
    </>
  );
}

function RacePanel({ run }: { run: Run }) {
  return (
    <div className="decide">
      <h3 className="decide-title">This plan came from a race, which only rehearses.</h3>
      <p>The server refuses to approve or apply a race's runs, so nothing from a race can reach prod. To go further, start a normal run with these exact steps. It rehearses them again, then a different person approves.</p>
      {canTakeToProd(run) && (
        <div className="decide-actions">
          <ToProdButton run={run} />
        </div>
      )}
    </div>
  );
}

function DecisionPanel({ run, setRun, pollFast }: { run: Run; setRun: (r: Run) => void; pollFast: (on: boolean) => void }) {
  if (run.race && run.status === 'awaiting_approval') return <RacePanel run={run} />;
  if (run.refused) return <RefusedNotice run={run} />;
  if (run.expired) return <ExpiredPanel run={run} />;
  switch (run.status) {
    case 'awaiting_approval':
      return run.can?.approve ? <ApprovePanel run={run} setRun={setRun} /> : <RequesterPanel run={run} />;
    case 'approved':
      return <ApplyPanel run={run} setRun={setRun} pollFast={pollFast} />;
    case 'applied':
    case 'rolled_back':
    case 'drift_detected':
      return <Outcome run={run} />;
    case 'applying':
      return <Notice tone="live" title="Writing the backup and applying to prod." />;
    case 'no_change':
      if (isReadOnly(run)) return <ReadOnlyPanel />;
      return <Notice tone="neutral" title="Nothing to apply.">The rehearsal changed nothing, so nothing reached prod and there is nothing to approve.</Notice>;
    case 'rejected':
      return (
        <Notice tone="neutral" title={`Rejected by ${run.rejection?.by ?? 'unknown'} at ${when(run.rejection?.at)}.`}>
          {run.rejection?.reason || 'No reason given.'}
        </Notice>
      );
    case 'blocked': {
      const guardrail = run.final?.verdict === 'failed_guardrails';
      if (run.race?.lane === 'alone') {
        return (
          <Notice tone="neutral" title="Rehearsed only. Nothing reached prod.">
            {run.blocked_reason ?? 'This plan is only measured.'}
          </Notice>
        );
      }
      return (
        <div className="outcome tone-bad">
          <div className="outcome-word">
            <Mark tone="bad" size={36} />
            Blocked. Nothing reached prod.
          </div>
          <p className="outcome-line">{run.blocked_reason ?? 'The run was blocked.'}</p>
          {evadedAttempt(run.attempts) && <EvadedNotice attempt={evadedAttempt(run.attempts)!} />}
          <p>{guardrail ? 'There is nothing for a reviewer to sign. The plan itself has to change.' : 'There is nothing to approve. The plan itself has to change.'}</p>
          <p>
            <Link href="/">Start a new task</Link>
          </p>
        </div>
      );
    }
    case 'error':
      return (
        <Notice tone="bad" title="The run failed, so there is nothing to decide.">
          <span className="mono">{run.error ?? 'No detail given.'}</span>
        </Notice>
      );
    default:
      return <p className="notmeasured">No decision yet. The rehearsal has to finish first.</p>;
  }
}
