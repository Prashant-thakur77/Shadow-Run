import type { CSSProperties, ReactNode } from 'react';
import type { Attempt, Metric, Run } from '../api/types';
import { bytes, money, num, plural, signedMoney } from '../lib/format';
import { statusInfo, verdictText, verdictTone } from '../lib/status';
import { Mark } from '../ui/bits';
import { failedGuardrails } from './derive';
import { biggestLoss, dollarsLost, hasMoved, metricDelta, metricValue } from './metrics';

/** When to show it: more than one attempt or a blocked run, with at least one real measurement to compare. */
export function showsComparison(run: Run): boolean {
  const attempts = run.attempts ?? [];
  if (!attempts.length) return false;
  if (attempts.length < 2 && run.status !== 'blocked') return false;
  return !!attempts[0].report || !!(run.final ?? attempts[attempts.length - 1]).report;
}

function MetricCell({ m }: { m?: Metric }) {
  if (!m) return <span className="ww-none">Not measured</span>;
  if (!hasMoved(m)) {
    return (
      <span className="ww-same">
        <Mark tone="good" size={12} /> Unchanged
      </span>
    );
  }
  const lost = dollarsLost(m) !== null;
  return (
    <span className={lost ? 'ww-lost' : 'ww-moved'}>
      <strong className="mono">{metricDelta(m)}</strong>
      <span className="ww-range mono">
        {metricValue(m.before, m.unit)} → {m.lost_entirely ? 'gone' : metricValue(m.after, m.unit)}
      </span>
    </span>
  );
}

function Row({ label, left, right }: { label: ReactNode; left: ReactNode; right?: ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{left}</td>
      {right !== undefined && <td>{right}</td>}
    </tr>
  );
}

/** What the checks found in the first plan. It sits under "Without Shadow Run", so it says what the plan does. */
function attemptLine(a: Attempt | undefined): { text: string; tone: ReturnType<typeof verdictTone> } {
  if (!a) return { text: 'Not measured', tone: 'neutral' };
  const failed = failedGuardrails(a);
  const tone = verdictTone(a.verdict);
  switch (a.verdict) {
    case 'failed_guardrails':
      return { text: `Breaks ${failed} ${failed === 1 ? 'guardrail' : 'guardrails'}`, tone };
    case 'blocked_by_gate':
      return { text: failed ? `Breaks ${failed} ${failed === 1 ? 'guardrail' : 'guardrails'}, and the gate refuses it` : 'The gate refuses it', tone };
    case 'evaded_rule':
      return { text: 'Breaks no guardrail, by getting around one it broke', tone };
    case 'passed':
      return { text: 'Breaks no guardrail', tone };
    default:
      return { text: verdictText(a.verdict, failed), tone };
  }
}

/** The first plan against where the run ended up. The dollar figure is the point of the page. */
export function WithWithout({ run }: { run: Run }) {
  const attempts = run.attempts ?? [];
  const first = attempts[0];
  const last = run.final ?? attempts[attempts.length - 1];
  const left = first?.report;
  const right = last?.report;
  const isHost = left?.kind === 'host' || right?.kind === 'host';
  // A blocked run put nothing on prod, whatever its last plan would have done.
  const stopped = run.status === 'blocked' || run.status === 'rejected';
  const single = attempts.length === 1;

  const fromAgent = !!run.task && run.source !== 'rehearse_again' && run.source !== 'undo';
  const subject = run.incident ? 'this command' : fromAgent ? "the agent's first plan" : 'this plan';
  const loss = biggestLoss(left);
  const lt = left?.totals ?? {};
  const rt = right?.totals ?? {};

  const names: string[] = [];
  for (const m of [...(left?.metrics ?? []), ...(right?.metrics ?? [])]) {
    if (m.id && hasMoved(m) && !names.includes(m.id)) names.push(m.id);
  }
  const byId = (list: Metric[] | undefined, id: string) => list?.find((m) => m.id === id);
  const leftLine = attemptLine(first);
  const info = statusInfo(run.status);

  const measures: { key: string; label: ReactNode; left: ReactNode; right: ReactNode }[] = isHost
    ? [
        { key: 'files', label: 'Files deleted', left: <strong className="mono">{num(lt.files_deleted)}</strong>, right: <strong className="mono">{num(rt.files_deleted)}</strong> },
        { key: 'space', label: 'Space freed', left: <span className="mono">{bytes(lt.bytes_freed)}</span>, right: <span className="mono">{bytes(rt.bytes_freed)}</span> },
        { key: 'services', label: 'Services stopped', left: <span className="mono">{num(lt.services_stopped)}</span>, right: <span className="mono">{num(rt.services_stopped)}</span> },
      ]
    : [
        { key: 'rows', label: 'Rows changed', left: <strong className="mono">{num(lt.rows_changed)}</strong>, right: <strong className="mono">{num(rt.rows_changed)}</strong> },
        { key: 'cascade', label: 'Rows via cascade', left: <strong className="mono">{num(lt.rows_via_cascade)}</strong>, right: <strong className="mono">{num(rt.rows_via_cascade)}</strong> },
      ];
  for (const id of names) {
    const l = byId(left?.metrics, id);
    const r = byId(right?.metrics, id);
    measures.push({ key: id, label: l?.name ?? r?.name ?? id, left: <MetricCell m={l} />, right: <MetricCell m={r} /> });
  }

  // The headline is the measured loss. With no loss, the largest sum of money it moved, then the size of
  // the change. A plan that measured none of those gets no headline, because a big zero would mislead.
  const movedMoney = (left?.metrics ?? [])
    .filter((m) => m.unit === 'usd' && hasMoved(m))
    .sort((x, y) => Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0))[0];
  const size = isHost ? lt.files_deleted : lt.rows_changed;
  // These are records on a seeded database, not money anyone spent, so the wording says what they are.
  const seeded = run.target_id?.startsWith('demo') ?? false;
  const headline = loss
    ? { label: seeded ? 'erased, on this seeded demo' : 'erased', number: money(loss.lost), of: `${loss.metric.name}${loss.metric.lost_entirely ? ', lost entirely' : ''}. Measured on a clone.`, tone: 'bad' }
    : movedMoney
      ? { label: 'moved', number: signedMoney(movedMoney.delta), of: `${movedMoney.name}. Measured on a clone.`, tone: 'bad' }
      : (size ?? 0) > 0
        ? { label: isHost ? 'deleted' : 'changed', number: num(size), of: `${plural(size ?? 0, isHost ? 'file' : 'row')}. Measured on a clone.`, tone: 'bad' }
        : null;

  return (
    <div className="ww">
      {headline && (
        <div className={`ww-hero tone-${headline.tone}`}>
          <p className="ww-hero-label">
            Without Shadow Run, {subject} would have {headline.label}
          </p>
          <div className="ww-hero-num mono" style={{ '--chars': headline.number.length } as CSSProperties}>
            {headline.number}
          </div>
          <p className="ww-hero-of">{headline.of}</p>
        </div>
      )}

      <div className="scroll-x">
        <table className="ww-table">
          <thead>
            <tr>
              <th scope="col" className="ww-corner"></th>
              <th scope="col" className="ww-head is-without">
                <span className="ww-head-title">Without Shadow Run</span>
                <span className="ww-head-sub">What {subject} would have done, measured on a clone</span>
              </th>
              <th scope="col" className="ww-head is-with">
                <span className="ww-head-title">With Shadow Run</span>
                <span className="ww-head-sub">
                  {stopped
                    ? 'Stopped. Nothing reached prod.'
                    : single
                      ? info.label
                      : `Attempt ${last?.n ?? attempts.length}, the plan that ${run.status === 'applied' ? 'was applied' : 'stands now'}. ${info.label}.`}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <Row
              label="What it does"
              left={
                <span className={`ww-verdict tone-${leftLine.tone}`}>
                  <Mark tone={leftLine.tone} size={13} /> {leftLine.text}
                </span>
              }
              right={
                <span className={`ww-verdict tone-${info.tone}`}>
                  <Mark tone={info.tone} size={13} /> {info.label}
                </span>
              }
            />
            {measures.map((row, i) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{row.left}</td>
                {stopped
                  ? i === 0 && (
                      <td className="ww-stopped" rowSpan={measures.length}>
                        <strong>Nothing reached prod.</strong>
                        {run.prod_check?.unchanged === true && <span>Prod's hash, checked from outside the sandbox, did not change.</span>}
                      </td>
                    )
                  : <td>{row.right}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
