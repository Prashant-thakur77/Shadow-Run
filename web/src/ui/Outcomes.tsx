import '../styles/outcomes.css';
import type { CSSProperties, ReactNode } from 'react';
import { isNum, num } from '../lib/format';
import type { Tone } from '../lib/status';
import { Mark } from './bits';
import { Label } from './Label';
import { Measured } from './Measured';

/** A figure from the benchmark. The landing page only gets the mean, and the Results page gets each run too. */
export interface OutcomeFigure {
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  per_run?: number[] | null;
}

export interface OutcomeMode {
  key: string;
  label: string;
  done: OutcomeFigure | undefined;
  harm: OutcomeFigure | undefined;
}

/** The one sum on these pages: tasks minus the other two. */
export function neitherOf(total: number | null | undefined, done: number | null | undefined, harm: number | null | undefined): number | null {
  if (!isNum(total) || !isNum(done) || !isNum(harm)) return null;
  return Math.max(0, Math.round((total - done - harm) * 100) / 100);
}

/** True only when rehearsing beat both of the others on work finished, so the words can't outrun the numbers. */
export function finishesMore(modes: OutcomeMode[]): boolean {
  const best = modes[modes.length - 1]?.done?.mean;
  const others = modes.slice(0, -1).map((m) => m.done?.mean);
  return isNum(best) && others.length > 0 && others.every((v) => isNum(v) && best > v);
}

/** A gap under one task, or ranges that overlap across runs, can't tell two modes apart. */
function noiseNote(modes: OutcomeMode[]): string | null {
  const a = modes[0]?.harm;
  const b = modes[1]?.harm;
  if (!isNum(a?.mean) || !isNum(b?.mean) || a.mean === b.mean) return null;
  if (isNum(a.min) && isNum(a.max) && isNum(b.min) && isNum(b.max)) {
    if (a.min > b.max || b.min > a.max) return null;
    return `The gap between ${num(a.mean)} and ${num(b.mean)} is noise at this sample size: ${num(a.min)} to ${num(a.max)} and ${num(b.min)} to ${num(b.max)} across runs.`;
  }
  return Math.abs(a.mean - b.mean) < 1 ? `The gap between ${num(a.mean)} and ${num(b.mean)} is noise at this sample size.` : null;
}

function neitherNote(modes: OutcomeMode[], total: number | null | undefined): string {
  const values = modes.map((m) => neitherOf(total, m.done?.mean, m.harm?.mean));
  const last = values[values.length - 1];
  const most = isNum(last) && values.slice(0, -1).every((v) => isNum(v) && last > v);
  return `Neither: the job didn't get done and prod wasn't harmed. Someone still has to do that work${most ? ', and Shadow Run leaves the most of it' : ''}.`;
}

/** One strip per run, one cell per task: done from the left, harm from the right, and the gap is neither.
 *  Cells are counted, not matched to tasks. Runs are paired in the benchmark's own order. */
function RunStrips({ total, mode }: { total: number; mode: OutcomeMode }) {
  const done = mode.done?.per_run;
  const harm = mode.harm?.per_run;
  if (!done?.length || done.length !== harm?.length) return <span className="oc-none">Not measured</span>;
  const line = (d: number, r: number) => `Run ${r + 1}: ${d} did the job, ${harm[r]} did harm, ${neitherOf(total, d, harm[r]) ?? 0} neither`;
  return (
    <span className="oc-strips" role="img" aria-label={`${done.map(line).join('. ')}.`} style={{ '--n': total } as CSSProperties}>
      {done.map((d, r) => (
        <span className="oc-strip" key={r} title={line(d, r)}>
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={i < d ? 'is-good' : i >= total - harm[r] ? 'is-bad' : undefined} />
          ))}
        </span>
      ))}
    </span>
  );
}

const toneClass = (tone: Tone) => (tone === 'neutral' ? '' : `is-${tone}`);

interface OutcomeRow {
  key: string;
  label: string;
  tone: Tone;
  value: (m: OutcomeMode) => number | null | undefined;
  cell: (v: number | null | undefined) => Tone;
}

/** Did the job, did harm, or neither, for the same tasks three ways, with the seam before Shadow Run. */
export function Outcomes({ total, modes, aside, showRuns = false }: { total: number | null | undefined; modes: OutcomeMode[]; aside?: ReactNode; showRuns?: boolean }) {
  const rows: OutcomeRow[] = [
    { key: 'done', label: 'Did the job with no harm', tone: 'good', value: (m) => m.done?.mean, cell: (v) => (isNum(v) && v > 0 ? 'good' : 'neutral') },
    { key: 'harm', label: 'Harm on prod', tone: 'bad', value: (m) => m.harm?.mean, cell: (v) => (!isNum(v) ? 'neutral' : v === 0 ? 'good' : 'bad') },
    { key: 'neither', label: 'Neither', tone: 'neutral', value: (m) => neitherOf(total, m.done?.mean, m.harm?.mean), cell: () => 'neutral' },
  ];
  const noise = noiseNote(modes);
  const lastMode = modes.length - 1;
  return (
    <div className="oc">
      <div className="oc-main">
        <table className="oc-table" role="table">
          <colgroup>
            <col className="oc-col-label" />
            <col className="oc-col-mode" />
            <col className="oc-col-mode" />
            <col className="oc-col-last" />
          </colgroup>
          <thead role="rowgroup">
            <tr className="oc-sides" role="row">
              <td />
              <th scope="colgroup" colSpan={lastMode} role="columnheader">
                <Label>No rehearsal</Label>
              </th>
              <th scope="col" className="oc-cold" role="columnheader">
                <Label>Shadow Run</Label>
              </th>
            </tr>
            <tr className="oc-modes" role="row">
              <td />
              {modes.map((m, i) => (
                <th scope="col" className={i === lastMode ? 'oc-cold' : undefined} key={m.key} role="columnheader">
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map((row) => (
              <tr className={`oc-row oc-row-${row.key}`} key={row.key} role="row">
                <th scope="row" role="rowheader">
                  <span className={`oc-row-name ${toneClass(row.tone)}`}>
                    <Mark tone={row.tone} size={13} />
                    <span>{row.label}</span>
                  </span>
                </th>
                {modes.map((m, i) => {
                  const v = row.value(m);
                  return (
                    <td className={`${i === lastMode ? 'oc-cold ' : ''}${toneClass(row.cell(v))}`} key={m.key} role="cell">
                      <Measured value={v} format={num} className="t-num-xl oc-num" source={row.key === 'neither' ? 'tasks minus the other two' : undefined} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {showRuns && isNum(total) && (
              <tr className="oc-row oc-row-runs" role="row">
                <th scope="row" role="rowheader">
                  <span className="oc-row-name">Each run, one cell per task</span>
                </th>
                {modes.map((m, i) => (
                  <td className={i === lastMode ? 'oc-cold' : undefined} key={m.key} role="cell">
                    <RunStrips total={total} mode={m} />
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
        <ul className="oc-notes">
          <li>{neitherNote(modes, total)}</li>
          {noise && <li>{noise}</li>}
        </ul>
      </div>
      {aside && <div className="oc-aside">{aside}</div>}
    </div>
  );
}

/** Answers the obvious objection from the same numbers, and says plainly what happens with nobody there. */
export function HoldQueueAnswer({
  total,
  modes,
  harmAlone,
  held,
  question = true,
  doneIsClear = false,
}: {
  total: number | null | undefined;
  modes: OutcomeMode[];
  harmAlone: number | null | undefined;
  held: number | null | undefined;
  question?: boolean;
  /** Only bench/stats.py's paired test over tasks may say more work got done. Without it, the page doesn't. */
  doneIsClear?: boolean;
}) {
  const agent = modes[0];
  const unread = modes[modes.length - 1];
  const answers = question && isNum(agent?.harm?.mean) && isNum(unread?.harm?.mean) && unread.harm!.mean! < agent.harm!.mean!;
  const more = doneIsClear && finishesMore(modes);
  return (
    <>
      {answers && (
        <div className="oc-answer">
          <h3 className="t-h3">Isn't this just a hold queue?</h3>
          <p>{more ? "A queue can cut harm by holding everything. It can't finish more work." : 'A queue approved unread lets every plan through exactly as the agent wrote it.'}</p>
          <p>
            Approve everything unread in a plain queue and you get the agent's own plans: <span className="mono">{num(agent.done?.mean)}</span> done, <span className="mono">{num(agent.harm?.mean)}</span> harmful. Here the same approvals give <span className="mono">{num(unread.done?.mean)}</span> and <span className="mono">{num(unread.harm?.mean)}</span>, because a plan that broke a rule on the clone went back to the agent first.
            {more ? '' : ' The drop in harm holds up task by task. The rise in work done could be chance at this sample.'}
          </p>
        </div>
      )}
      {isNum(harmAlone) && (
        <div className="oc-alone">
          <span className="t-label">With no person</span>
          <p className="oc-alone-line">
            <span className={`t-num-l ${harmAlone === 0 ? 'is-good' : 'is-bad'}`}>
              <Measured value={harmAlone} format={num} />
            </span>{' '}
            <span className={harmAlone === 0 ? 'is-good' : 'is-bad'}>
              <Mark tone={harmAlone === 0 ? 'good' : 'bad'} size={15} />
            </span>{' '}
            <span className="oc-alone-words">
              harm on prod
              {isNum(held) && isNum(total) && (
                <>
                  , with <span className="mono">{num(held)}</span> of <span className="mono">{num(total)}</span> waiting for someone
                </>
              )}
              .
            </span>
          </p>
        </div>
      )}
    </>
  );
}
