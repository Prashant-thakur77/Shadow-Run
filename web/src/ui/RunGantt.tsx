import type { PublicHero } from '../api/types';
import { ms as fmtMs } from '../lib/format';
import type { Tone } from '../lib/status';
import { Mark } from './bits';
import { Stamp } from './Stamp';

export interface GanttBar {
  name: string;
  /** Offset in milliseconds from the start of the axis. */
  start: number;
  /** Measured length in milliseconds. While `live`, the wall clock so far, drawn but never printed. */
  ms: number;
  tone?: 'good' | 'bad';
  live?: boolean;
  /** A short fact after the time, such as "cached". */
  note?: string;
}

export interface GanttAttempt {
  /** Identifies the row when rows can be selected. */
  id?: number;
  label: string;
  /** What the attempt ended in. Coloured only when a measurement says so. */
  outcome?: string;
  tone?: Tone;
  /** A quiet fact at the end of the row, such as the plan hash. */
  note?: string;
  bars: GanttBar[];
}

export interface GanttStep {
  label: string;
  reached: boolean;
  tone?: Tone;
}

const PHASES: [keyof PublicHero['phases'], string][] = [
  ['clone_boot_ms', 'boot'],
  ['first_exec_ms', 'first exec'],
  ['probe_ms', 'probes'],
  ['execute_ms', 'execute'],
  ['secret_scan_ms', 'secret scan'],
  ['destroy_ms', 'destroy'],
];

/** Phases laid end to end from `start`. A phase that wasn't measured is left out, and nothing is stretched to fill a gap. */
export function barsFromPhases(phases: PublicHero['phases'], start = 0): GanttBar[] {
  const bars: GanttBar[] = [];
  let at = start;
  for (const [key, name] of PHASES) {
    const value = phases[key];
    if (typeof value !== 'number') continue;
    bars.push({ name, start: at, ms: value });
    at += value;
  }
  return bars;
}

function niceStep(total: number): number {
  const rough = total / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  const n = rough / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * pow;
}

function barClass(b: GanttBar): string {
  return `gantt-bar${b.tone ? ` is-${b.tone}` : ''}${b.live ? ' is-live' : ''}`;
}

/** Every phase on its own line, each offset along the same axis, so the shape of the run reads at a glance. */
function PhaseRows({ bars, end }: { bars: GanttBar[]; end: number }) {
  return (
    <>
      {bars.map((b) => (
        <div className="gantt-row" key={b.name}>
          <span>{b.name}</span>
          <span className="gantt-track" aria-hidden="true">
            <span className={barClass(b)} style={{ left: `${(b.start / end) * 100}%`, width: `${(b.ms / end) * 100}%` }} />
          </span>
          <span className="gantt-value">
            {b.live ? 'running' : fmtMs(b.ms)}
            {b.note && <span className="gantt-note"> {b.note}</span>}
          </span>
        </div>
      ))}
    </>
  );
}

/** One line for a whole attempt: its phases end to end. Comparing attempts is the point, so they share an axis. */
function Summary({ bars, end }: { bars: GanttBar[]; end: number }) {
  return (
    <span className="gantt-track gantt-track-full" aria-hidden="true">
      {bars.map((b) => (
        <span key={b.name} className={barClass(b)} style={{ left: `${(b.start / end) * 100}%`, width: `${(b.ms / end) * 100}%` }} />
      ))}
    </span>
  );
}

/** The stepper above the bars only advances on a real status, so an unreached step is simply not lit.
 *  With several attempts each gets a summary line, and the selected one opens into its phases. */
export function RunGantt({
  attempts,
  stepper,
  total,
  className = '',
  selected,
  onSelect,
}: {
  attempts: GanttAttempt[];
  stepper?: GanttStep[];
  total?: number;
  className?: string;
  /** Which attempt's phases are open, when there's more than one. */
  selected?: number | null;
  onSelect?: (id: number) => void;
}) {
  const end = total ?? Math.max(1, ...attempts.flatMap((a) => a.bars.map((b) => b.start + b.ms)));
  const step = niceStep(end);
  const ticks: number[] = [];
  for (let t = 0; t <= end; t += step) ticks.push(t);
  const several = attempts.length > 1;
  return (
    <div className={`gantt ${className}`}>
      {stepper && (
        <ol className="gantt-stepper">
          {stepper.map((s) => (
            <li key={s.label} className={`${s.reached ? 'is-reached' : ''}${s.tone ? ` tone-${s.tone}` : ''}`}>
              {s.reached && s.tone && s.tone !== 'neutral' ? <Mark tone={s.tone} size={11} /> : null}
              {s.label}
            </li>
          ))}
        </ol>
      )}
      {attempts.map((a) => {
        const open = !several || a.id === undefined || a.id === selected;
        const head = (
          <>
            <span className="t-label gantt-attempt-label">{a.label}</span>
            {a.outcome && <Stamp tone={a.tone ?? 'neutral'}>{a.outcome}</Stamp>}
            {a.note && <span className="gantt-attempt-note">{a.note}</span>}
          </>
        );
        return (
          <div className={`gantt-attempt${several && open ? ' is-open' : ''}`} key={a.id ?? a.label}>
            {several && onSelect && a.id !== undefined ? (
              <button type="button" className="gantt-attempt-head is-button" aria-pressed={a.id === selected} onClick={() => onSelect(a.id as number)}>
                {head}
              </button>
            ) : (
              <div className="gantt-attempt-head">{head}</div>
            )}
            {several && a.bars.length > 0 && (
              <div className="gantt-row gantt-row-summary">
                <span />
                <Summary bars={a.bars} end={end} />
                <span className="gantt-value">{fmtMs(a.bars.reduce((sum, b) => sum + b.ms, 0))}</span>
              </div>
            )}
            {open && <PhaseRows bars={a.bars} end={end} />}
          </div>
        );
      })}
      <div className="gantt-axis" aria-hidden="true">
        <span />
        <span className="gantt-axis-ticks">
          {ticks.map((t) => (
            <span key={t} style={{ left: `${(t / end) * 100}%` }}>
              {t === 0 ? '0' : t >= 1000 ? `${t / 1000} s` : `${t} ms`}
            </span>
          ))}
        </span>
        <span />
      </div>
    </div>
  );
}
