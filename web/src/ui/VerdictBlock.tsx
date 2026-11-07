import '../styles/verdict.css';
import type { TaskCompare } from '../api/types';
import { num } from '../lib/format';

const signed = (v: number | undefined) => (v === undefined ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${num(Math.abs(v))}`);

/** One comparison as an exhibit: before and after in the eyebrow, the difference as the figure, and what the paired
 * test over tasks says about it. Every value is read from bench/stats.json; nothing here is computed. */
export function VerdictBlock({ c, label, unit, better }: { c: TaskCompare | undefined; label: string; unit: string; better: 'down' | 'up' }) {
  if (!c || c.difference === undefined) return null;
  const clear = !!c.excludes_zero;
  const good = clear && (better === 'down' ? c.difference < 0 : c.difference > 0);
  const bad = clear && !good;
  return (
    <div className={`vb${good ? ' is-good' : bad ? ' is-bad' : ''}`}>
      <span className="vb-eyebrow mono">
        [ {num(c.from)} → {num(c.to)} {unit} ]
      </span>
      <span className="vb-figure">{signed(c.difference)}</span>
      <span className="vb-label">{label}</span>
      <span className="vb-test">
        {clear ? 'Holds task by task' : 'Could be chance at this sample'}
        {c.ci95 ? (
          <span className="mono">
            {' '}
            · 95% interval {signed(c.ci95[0])} to {signed(c.ci95[1])} · p = {num(c.permutation_p)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function VerdictPair({ harm, done, tasks }: { harm: TaskCompare | undefined; done: TaskCompare | undefined; tasks: number | null | undefined }) {
  if (!harm && !done) return null;
  return (
    <div className="vb-pair">
      <VerdictBlock c={harm} label={`tasks harmed on prod, of ${num(tasks)}, with every plan approved unread`} unit="harmed" better="down" />
      <VerdictBlock c={done} label={`tasks done with no harm, of ${num(tasks)}, same runs`} unit="done" better="up" />
    </div>
  );
}

/** The claim no control arm makes: harm that reached prod before any person saw the plan. Read from bench/results.json. */
export function HeldVerdict({ direct, alone, held, tasks }: { direct: number | null | undefined; alone: number | null | undefined; held: number | null | undefined; tasks: number | null | undefined }) {
  if (alone === null || alone === undefined || direct === null || direct === undefined) return null;
  return (
    <div className={`vb vb-lead${alone === 0 ? ' is-good' : ' is-bad'}`}>
      <span className="vb-eyebrow mono">
        [ {num(direct)} → {num(alone)} before anyone saw it ]
      </span>
      <span className="vb-figure">{num(alone)}</span>
      <span className="vb-label">
        of {num(tasks)} risky tasks did harm on prod before a person saw the plan. The agent alone: {num(direct)}. A prompt with the rules or a transaction lets a passing plan land with nobody looking.
      </span>
      <span className="vb-test">
        {held !== null && held !== undefined ? `${num(held)} of ${num(tasks)} risky plans waited for a person, which is where the zero comes from` : 'The zero comes from the hold'}
        <span className="mono"> · bench/results.json</span>
      </span>
    </div>
  );
}
