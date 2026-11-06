import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { notifyProdChanged, raw } from '../api/client';
import type { Run } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { asText } from '../lib/format';
import { Mark } from '../ui/bits';
import { Stamp } from '../ui/Stamp';
import { measureProdBeforeApply } from './ProdProof';

export interface BreakResult {
  request: string;
  as: string;
  status: number;
  message: string;
  outcome: string | null;
  matched: boolean;
}

/** Changes the last hex digit, so the value stays well formed and only the content is wrong. */
function tamper(hash: string): string {
  const last = hash.slice(-1);
  return hash.slice(0, -1) + (last === '0' ? '1' : '0');
}

interface Control {
  key: string;
  title: string;
  what: string;
  expect: string;
  disabled?: string | null;
  run: () => Promise<BreakResult[]>;
}

function ResultLine({ r }: { r: BreakResult }) {
  const refused = r.matched && r.status >= 400;
  return (
    <div className={`breakres${r.matched ? ' is-match' : ' is-miss'}`}>
      <div className="breakres-req mono">
        {r.request} <span className="muted">as {r.as}</span>
      </div>
      <div className="breakres-out">
        {refused ? (
          <Stamp tone="good" land>
            Refused <span className="breakres-code">{r.status}</span>
          </Stamp>
        ) : (
          <span className="breakres-code mono">{r.status || 'no response'}</span>
        )}
        <span className="breakres-msg">{r.outcome ? <><code className="mono">{r.outcome}</code> </> : null}{r.message}</span>
        <span className="breakres-verdict">
          <Mark tone={r.matched ? 'good' : 'bad'} size={13} />
          {r.matched ? 'As expected' : 'Not as expected'}
        </span>
      </div>
    </div>
  );
}

export function BreakItPanel({
  run,
  setRun,
  pollFast,
  results,
  setResults,
}: {
  run: Run;
  setRun: (r: Run) => void;
  pollFast: (on: boolean) => void;
  results: Record<string, BreakResult[]>;
  setResults: Dispatch<SetStateAction<Record<string, BreakResult[]>>>;
}) {
  const { tokenFor, user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [drifted, setDrifted] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const path = `/api/runs/${encodeURIComponent(run.id)}`;
  const requester = run.requester ?? user?.username ?? 'judge';
  const checker = requester === 'reviewer' ? 'judge' : 'reviewer';
  const isHost = run.final?.report?.kind === 'host';
  const touched = useMemo(() => (run.final?.report?.tables ?? []).map((t) => t.table), [run.final]);
  const seesDrift = isHost || touched.includes('users');
  const driftPath = `/api/demo/drift${run.target_id ? `?target_id=${encodeURIComponent(run.target_id)}` : ''}`;

  const send = async (who: string, method: string, url: string, body: unknown): Promise<Omit<BreakResult, 'matched' | 'outcome'> & { body: unknown }> => {
    const token = await tokenFor(who);
    if (!token) throw new Error('cancelled');
    const res = await raw(method, url, body, token);
    return { request: `${method} ${url}`, as: who, status: res.status, message: res.message, body: res.body };
  };

  const challenge = run.challenge;
  const approval = run.approval;

  // Past the window the server answers 410 before it compares any hash.
  const windowClosed = !!challenge?.expires_at && challenge.expires_at * 1000 <= Date.now();
  const refusedTampered = windowClosed ? 410 : 409;

  const controls: Control[] = [];
  if (run.status === 'awaiting_approval' && challenge) {
    controls.push(
      {
        key: 'self',
        title: 'Approve your own run',
        what: `Sends the correct hashes, signed in as ${requester}, who requested it.`,
        expect: '403',
        run: async () => {
          const r = await send(requester, 'POST', `${path}/approve`, challenge);
          return [{ ...r, outcome: null, matched: r.status === 403 }];
        },
      },
      {
        key: 'plan',
        title: 'Approve with a tampered plan hash',
        what: `Signed in as ${checker}. One digit of plan_hash is changed.`,
        expect: String(refusedTampered),
        run: async () => {
          const r = await send(checker, 'POST', `${path}/approve`, { ...challenge, plan_hash: tamper(challenge.plan_hash) });
          return [{ ...r, outcome: null, matched: r.status === refusedTampered }];
        },
      },
      {
        key: 'report',
        title: 'Approve with a tampered report',
        what: `Signed in as ${checker}. One digit of report_hash is changed.`,
        expect: String(refusedTampered),
        run: async () => {
          const r = await send(checker, 'POST', `${path}/approve`, { ...challenge, report_hash: tamper(challenge.report_hash) });
          return [{ ...r, outcome: null, matched: r.status === refusedTampered }];
        },
      },
    );
  }
  if (run.status === 'approved' && approval) {
    const approver = approval.approver_id && approval.approver_id !== requester ? approval.approver_id : checker;
    const applyWith = async (driftCheck: boolean, want: string): Promise<BreakResult[]> => {
      pollFast(true);
      try {
        await measureProdBeforeApply(run);
        const r = await send(user?.username ?? requester, 'POST', `${path}/apply`, { drift_check: driftCheck });
        const body = r.body as Run | null;
        if (r.status >= 200 && r.status < 300 && body?.id) {
          setRun(body);
          notifyProdChanged();
        }
        const status = body?.status ?? null;
        return [{ ...r, outcome: status, message: body?.apply?.reason ?? r.message, matched: status === want }];
      } finally {
        pollFast(false);
      }
    };
    controls.push(
      {
        key: 'replay',
        title: 'Replay the approval',
        what: `Sends the same approval again, signed in as ${approver}.`,
        expect: '409',
        run: async () => {
          const r = await send(approver, 'POST', `${path}/approve`, {
            plan_hash: approval.plan_hash,
            guardrails_hash: approval.guardrails_hash,
            report_hash: approval.report_hash,
            nonce: approval.nonce,
          });
          return [{ ...r, outcome: null, matched: r.status === 409 }];
        },
      },
      {
        key: 'drift',
        title: 'Change prod behind its back',
        what: isHost
          ? 'Appends one line to a log file on the server, outside Shadow Run. Do this before the next step.'
          : 'Writes one user straight into demo prod, outside Shadow Run. Do this before the next two.',
        expect: 'a row written',
        run: async () => {
          const r = await send(user?.username ?? requester, 'POST', driftPath, {});
          const body = r.body as { inserted_user_id?: number; what?: string } | null;
          const ok = r.status >= 200 && r.status < 300;
          if (ok) {
            setDrifted(true);
            notifyProdChanged();
          }
          return [{ ...r, outcome: body?.inserted_user_id !== undefined ? `user ${asText(body.inserted_user_id)}` : null, message: body?.what ?? r.message, matched: ok }];
        },
      },
      {
        key: 'apply-on',
        title: 'Now apply, drift check on',
        what: 'The first line of defence compares prod with the snapshot. This uses up the approval.',
        expect: 'drift_detected',
        disabled: drifted ? null : 'Change prod first.',
        run: () => applyWith(true, 'drift_detected'),
      },
    );
    // On a host the write is one log line. With the first defence off, the files this plan touches still
    // match the rehearsal, so the apply would really commit. That is not a refusal, so it is not offered.
    if (!isHost) {
      controls.push({
        key: 'apply-off',
        title: 'Now apply, drift check off',
        what: 'Turns off the first line of defence. The plan really runs on prod, and the count check inside the transaction has to catch it. This uses up the approval.',
        expect: 'rolled_back',
        disabled: drifted ? null : 'Change prod first.',
        run: () => applyWith(false, 'rolled_back'),
      });
    }
  }

  const fire = async (c: Control) => {
    setBusy(c.key);
    try {
      const out = await c.run();
      if (mounted.current) setResults((prev) => ({ ...prev, [c.key]: [...(prev[c.key] ?? []), ...out] }));
    } catch (e) {
      if ((e as Error).message !== 'cancelled' && mounted.current) {
        setResults((prev) => ({
          ...prev,
          [c.key]: [...(prev[c.key] ?? []), { request: c.title, as: user?.username ?? '', status: 0, message: (e as Error).message, outcome: null, matched: false }],
        }));
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const shownKeys = new Set(controls.map((c) => c.key));
  const earlier = Object.entries(results).filter(([k]) => !shownKeys.has(k));

  return (
    <>
      <p className="break-intro">These really call the API. The refusals below come from the server, not from this page.</p>
      {run.status === 'approved' && !seesDrift && touched.length > 0 && (
        <p className="break-note">
          The write adds a row to <code className="mono">users</code>. This plan touches <code className="mono">{touched.join(', ')}</code>, so neither check will see it and the apply will commit. Use a plan that touches users to see the refusals.
        </p>
      )}
      {run.status === 'awaiting_approval' && windowClosed && (
        <p className="break-note">The approval window on this run has closed, so a tampered approval gets 410 here. A newer run gets 409.</p>
      )}
      <ul className="breaks">
        {controls.map((c) => (
          <li className="break" key={c.key}>
            <div className="break-main">
              <div className="break-title">{c.title}</div>
              <p className="break-what">{c.what}</p>
              <p className="break-expect">
                Expect <code className="mono">{c.expect}</code>
              </p>
            </div>
            <button type="button" className="btn" disabled={!!busy || !!c.disabled} title={c.disabled ?? undefined} onClick={() => void fire(c)}>
              {busy === c.key ? 'Sending' : 'Try it'}
            </button>
            {(results[c.key]?.length ?? 0) > 0 && (
              <div className="break-results">
                {results[c.key].map((r, i) => (
                  <ResultLine key={i} r={r} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      {run.status === 'awaiting_approval' && !windowClosed && (
        <p className="muted">
          Once a different person approves this run in <a href="#decision">Decision</a>, more appear here: replay the approval, and change prod behind its back.
        </p>
      )}
      {earlier.length > 0 && (
        <div className="break-earlier">
          <h3 className="subhead">Already tried on this run</h3>
          {earlier.flatMap(([k, rs]) => rs.map((r, i) => <ResultLine key={`${k}${i}`} r={r} />))}
        </div>
      )}
    </>
  );
}
