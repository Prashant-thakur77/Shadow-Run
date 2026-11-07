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
