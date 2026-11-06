import './_styles';
import '../styles/pg-evidence.css';
import { useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api/client';
import { asText, isNum, num, whenAny } from '../lib/format';
import type { Tone } from '../lib/status';
import { useAsync } from '../lib/useAsync';
import { CopyButton, Fold, Loading, Mark, Notice } from '../ui/bits';
import { Figure, sourceLine } from '../ui/Figure';
import { Frame } from '../ui/Frame';
import { Label } from '../ui/Label';
import { Measured } from '../ui/Measured';
import { PageHead, useFirstSight } from './_evidence';

// The shape bench/run.py's summarise() writes. Every field may be missing, and the page says so when it is.
interface PerRun {
  mean?: number | null;
  min?: number | null;
  max?: number | null;
  per_run?: number[] | null;
}
interface ModeStats {
  risky_tasks?: number;
  safe_tasks?: number;
  harm_on_prod?: PerRun;
  safe_wrongly_blocked?: PerRun;
  harm_if_rubber_stamped?: PerRun;
  held_harm_only_a_person_catches?: PerRun;
  risky_blocked_gate?: PerRun;
  risky_blocked_guardrail?: PerRun;
  risky_held?: PerRun;
  risky_auto_applied?: PerRun;
  safe_held?: PerRun;
  safe_auto_applied?: PerRun;
}
interface Block {
  label?: string;
  direct?: ModeStats;
  static_gate?: ModeStats;
  shadow_run?: ModeStats;
}
interface ResultsTable {
  columns?: unknown[];
  rows?: unknown[][];
}

const toneOf = (v: number | null | undefined): Tone => (!isNum(v) ? 'neutral' : v === 0 ? 'good' : 'bad');
const shown = (v: number | null | undefined) => (isNum(v) ? String(v) : null);
const SOURCE = 'bench/results.json';

function rangeText(p: PerRun | undefined): string | null {
  if (!p || !isNum(p.min) || !isNum(p.max) || p.min === p.max) return null;
  return `${p.min} to ${p.max} across runs`;
}

/** One strip per run, one cell per task. A cell is filled when the run counted that many, so a mean of 11.33 is
 *  three real strips and never a third of a square. Cells are counted, not matched to particular tasks. */
function Strips({ total, stats, tone, reveal }: { total: number; stats: PerRun | undefined; tone: Tone; reveal: boolean }) {
  const runs = stats?.per_run?.length ? stats.per_run : isNum(stats?.mean) ? [stats.mean] : [];
  return (
    <span className="ev-strips" style={{ '--n': total } as CSSProperties}>
      {runs.map((filled, r) => (
        <span className="ev-strip" key={r} title={`Run ${r + 1}: ${filled} of ${total}`}>
          {Array.from({ length: total }, (_, i) => {
            const part = Math.max(0, Math.min(1, filled - i));
            return (
              <i key={i} className={filled === 0 && tone === 'good' ? 'is-clear' : undefined}>
                {part > 0 && <b className={`is-${tone}${reveal ? ' is-land' : ''}`} style={{ width: `${part * 100}%`, animationDelay: `${Math.round((i * 560) / Math.max(1, total))}ms` }} />}
              </i>
            );
          })}
        </span>
      ))}
    </span>
  );
}

interface HarmRow {
  key: string;
  label: string;
  note: string;
  stats: PerRun | undefined;
  total: number | undefined;
}

function harmRows(b: Block): HarmRow[] {
  return [
    { key: 'direct', label: 'Agent directly', note: 'The agent runs its own plan on prod.', stats: b.direct?.harm_on_prod, total: b.direct?.risky_tasks },
    { key: 'static_gate', label: 'Static gate', note: 'A parser reads the plan first. Nothing is run ahead of time.', stats: b.static_gate?.harm_on_prod, total: b.static_gate?.risky_tasks },
    { key: 'shadow_run', label: 'Shadow Run, with no person', note: 'Nothing harmful reached prod without a person, because nearly every risky plan waited for one. Anything that holds every plan scores zero, so read the next number too.', stats: b.shadow_run?.harm_on_prod, total: b.shadow_run?.risky_tasks },
    { key: 'rubber_stamp', label: 'Shadow Run, rubber-stamped', note: 'The same plans, with a person approving everything without reading it. The drop from the first two numbers is the agent rewriting its plans after seeing the damage.', stats: b.shadow_run?.harm_if_rubber_stamped, total: b.shadow_run?.risky_tasks },
  ];
}

/** The four numbers, split by the seam: no rehearsal on one side, Shadow Run and its known gap on the other. */
function Verdict({ held, measured, runs }: { held: Block; measured: number | null; runs: number | undefined }) {
  const rows = harmRows(held);
  const risky = held.direct?.risky_tasks;
  const tile = (row: HarmRow) => {
    const tone = toneOf(row.stats?.mean);
    const value = shown(row.stats?.mean);
    return (
      <div className={`ev-tile is-${tone}`} key={row.key}>
        <dt className="ev-tile-name">{row.label}</dt>
        <dd className="ev-tile-value">
          {value === null ? (
            <span className="ev-tile-none">Not measured</span>
          ) : (
            <>
              <Measured value={row.stats?.mean} className="t-num-xl" source={SOURCE} />
              {tone !== 'neutral' && <Mark tone={tone} size={18} />}
            </>
          )}
        </dd>
        <dd className="ev-tile-note">{row.note}</dd>
        {rangeText(row.stats) && <dd className="t-caption">{rangeText(row.stats)}</dd>}
      </div>
    );
  };
  return (
    <Figure className="ev-figure-block" n={1} measured={measured} extra={`${SOURCE} · mean of ${num(runs)} runs per task · the benchmark's own harm checks`}>
      <h2 className="ev-statement">
        Harm on prod, of <span className="mono">{num(risky)}</span> risky tasks held out from tuning
      </h2>
      <Frame className="ev-verdict-frame">
        <div className="ev-verdict-side">
          <div className="ev-verdict-label">
            <Label>No rehearsal</Label>
          </div>
          <dl className="ev-verdict-tiles">{rows.slice(0, 2).map(tile)}</dl>
        </div>
        <div className="ev-verdict-side">
          <div className="ev-verdict-label">
            <Label>Shadow Run, and its gap</Label>
          </div>
          <dl className="ev-verdict-tiles">{rows.slice(2).map(tile)}</dl>
        </div>
      </Frame>
    </Figure>
  );
}

/** Harm across the four modes on one scale. The cells land once, and the number beside them never moves. */
function HarmChart({ block, n, measured }: { block: Block; n: number; measured: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const sight = useFirstSight(ref);
  const rows = harmRows(block);
  const total = block.direct?.risky_tasks;
  if (!isNum(total) || total <= 0) return null;
  const words = rows.map((r) => `${r.label}: ${shown(r.stats?.mean) ?? 'not measured'}`).join(', ');
  return (
    <div className={`ev-chart is-${sight}`} ref={ref}>
      <Figure n={n} measured={measured} extra={`${SOURCE} · 1 cell = 1 task · 1 strip = 1 run · cells are counted, not matched to tasks`}>
      <div className="ev-chart-title">
        <h2 className="t-h3">{block.label ?? 'Harm on prod'}</h2>
        <span className="t-caption">
          <span className="mono">{num(total)}</span> risky tasks
        </span>
      </div>
      <div className="ev-chart-rows" role="img" aria-label={`Harmful outcomes on prod, of ${total} risky tasks. ${words}.`}>
        {rows.map((row) => {
          const tone = toneOf(row.stats?.mean);
          const value = shown(row.stats?.mean);
          return (
            <div className={`ev-chart-row is-${row.key}`} key={row.key}>
              <span className="ev-chart-name">{row.label}</span>
              {value === null ? <span className="ev-chart-empty">Not measured</span> : <Strips total={isNum(row.total) ? row.total : total} stats={row.stats} tone={tone} reveal={sight === 'seen'} />}
              <span className={`ev-chart-value t-num-m is-${tone}`}>
                {tone !== 'neutral' && <Mark tone={tone} size={14} />} <Measured value={row.stats?.mean} source={SOURCE} empty="–" />
              </span>
            </div>
          );
        })}
      </div>
      </Figure>
    </div>
  );
}

/** Where the risky tasks went under Shadow Run, one run per strip. */
function Fates({ stats }: { stats: ModeStats }) {
  const total = stats.risky_tasks;
  const fates: { key: string; label: string; tone: Tone; p: PerRun | undefined }[] = [
    { key: 'gate', label: 'Refused by the gate', tone: 'neutral', p: stats.risky_blocked_gate },
    { key: 'guard', label: 'Failed a guardrail on the clone', tone: 'neutral', p: stats.risky_blocked_guardrail },
    { key: 'held', label: 'Held for a person', tone: 'caution', p: stats.risky_held },
    { key: 'auto', label: 'Applied with no person', tone: 'neutral', p: stats.risky_auto_applied },
  ];
  if (!isNum(total)) return null;
  return (
    <dl className="ev-fates">
      {fates.map((f) => (
        <div key={f.key}>
          <dt>{f.label}</dt>
          <dd className={`t-num-m is-${f.tone}`}>
            <Measured value={f.p?.mean} source={SOURCE} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The gap and the price, across the seam. Both are written from the numbers, so neither can outrun them. */
function GapAndPrice({ held, measured }: { held: Block; measured: number | null }) {
  const s = held.shadow_run;
  if (!s) return null;
  const rubber = s.harm_if_rubber_stamped;
  const safe = s.safe_tasks;
  const safeHeld = s.safe_held?.mean;
  const allHeld = isNum(safe) && isNum(safeHeld) && safeHeld === safe;
  const heldTone = isNum(safeHeld) && safeHeld > 0 ? 'caution' : 'neutral';
  return (
    <section className="ev-split" aria-label="What the zero depends on, and what it costs">
      <div className="ev-split-side">
        <Label>What the zero depends on</Label>
        <p className="ev-split-big">
          <Measured value={rubber?.mean} className={`t-num-xl is-${toneOf(rubber?.mean)}`} source={SOURCE} empty="–" />
          <span className="ev-split-of">
            of <span className="mono">{num(s.risky_tasks)}</span> risky tasks do harm if a person approves everything held
          </span>
        </p>
        <p className="ev-split-text">The benchmark applies each held plan anyway and runs the same harm check. These plans passed every guardrail, so reading the plan is the only thing left that stops them.</p>
        <Fates stats={s} />
      </div>
      <div className="ev-split-side">
        <Label>What it costs</Label>
        <p className="ev-split-big">
          <Measured value={safeHeld} className={`t-num-xl is-${heldTone}`} source={SOURCE} empty="–" />
          <span className="ev-split-of">
            of <span className="mono">{num(safe)}</span> safe tasks waited for a person
          </span>
        </p>
        {isNum(safe) && isNum(safeHeld) && (
          <Strips total={safe} stats={s.safe_held} tone={heldTone} reveal={false} />
        )}
        <p className="ev-split-text">{allHeld ? 'That is the price of this policy. None of that work applied until someone approved it.' : 'That is the price of this policy, measured. Anything held does not apply until someone approves it.'}</p>
        <dl className="ev-fates">
          <div>
            <dt>Applied with no person</dt>
            <dd className="t-num-m">
              <Measured value={s.safe_auto_applied?.mean} source={SOURCE} />
            </dd>
          </div>
          <div>
            <dt>Wrongly blocked</dt>
            <dd className="t-num-m">
              <Measured value={s.safe_wrongly_blocked?.mean} source={SOURCE} />
            </dd>
          </div>
        </dl>
      </div>
      <p className="t-caption ev-split-caption">{sourceLine({ n: 3, measured, extra: `${SOURCE} · mean per run · 1 strip = 1 run, 1 cell = 1 safe task` })}</p>
    </section>
  );
}

/** How many tasks a row counts, read from the benchmark's own label. Follow-on rows inherit it, and any other row gets no bar. */
function denominators(rows: unknown[][]): (number | null)[] {
  let last: number | null = null;
  return rows.map((r) => {
    const label = asText(r[0]);
    const m = label.match(/\bof (\d+)\b/);
    if (m) last = Number(m[1]);
    else if (!/^\.\.\.and|^safe tasks/i.test(label)) last = null;
    return last;
  });
}

function cellFigure(text: string): number | null {
  const m = text.match(/^(\d+(?:\.\d+)?)(?:\s|$)/);
  return m ? Number(m[1]) : null;
}

function rowKind(label: string): 'harm' | 'held' | 'plain' {
  if (/harm|rubber/i.test(label)) return 'harm';
  if (/held for a person/i.test(label)) return 'held';
  return 'plain';
}

/** The benchmark's own table, cell for cell. Bars share one scale, so one task is the same length in every row. */
function BenchTable({ table, colored }: { table: ResultsTable; colored: boolean }) {
  const rows = useMemo(() => (table.rows ?? []).map((r) => (Array.isArray(r) ? r : [r])), [table.rows]);
  const denoms = useMemo(() => denominators(rows), [rows]);
  const scale = Math.max(1, ...denoms.map((d) => d ?? 0));
  const columns = table.columns ?? [];
  return (
    <div className="ev-table-wrap">
      <table className="data ev-table" role="table">
        <thead role="rowgroup">
          <tr role="row">
            {columns.map((c, i) => (
              <th scope="col" role="columnheader" key={i}>
                {asText(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((r, i) => {
            const label = asText(r[0]);
            const kind = rowKind(label);
            const denom = denoms[i];
            return (
              <tr role="row" key={i} className={`is-${kind}${/rubber/i.test(label) ? ' is-gap' : ''}`}>
                {r.map((c, j) => {
                  const text = asText(c);
                  if (j === 0) {
                    return (
                      <th scope="row" role="rowheader" key={j}>
                        {text}
                      </th>
                    );
                  }
                  const figure = cellFigure(text);
                  const tone: Tone = !colored || kind === 'plain' || figure === null ? 'neutral' : kind === 'held' ? (figure > 0 ? 'caution' : 'neutral') : figure === 0 ? 'good' : 'bad';
                  return (
                    <td role="cell" key={j} data-col={asText(columns[j])} className={text === 'n/a' ? 'is-na' : undefined}>
                      <span className={`mono ev-cell is-${tone}`}>
                        {(tone === 'good' || tone === 'bad') && <Mark tone={tone} size={12} />} {text}
                      </span>
                      {denom !== null && figure !== null && (
                        <span className="ev-bar-track" style={{ width: `${(denom / scale) * 100}%` }} aria-hidden="true">
                          <i className={`is-${tone}`} style={{ width: `${Math.min(100, (figure / denom) * 100)}%` }} />
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Every kind of task on its own, so no group can hide inside a total. All tasks, including the tuning set. */
function ByKind({ groups }: { groups: Record<string, Block> }) {
  const rows = Object.entries(groups);
  if (!rows.length) return null;
  const cell = (p: PerRun | undefined) => shown(p?.mean) ?? 'n/a';
  return (
    <Fold summary="The same harm, by kind of task">
      <div className="ev-table-wrap">
        <table className="data ev-table ev-table-kinds" role="table" aria-label="Harm on prod by kind of task, including the tuning set">
          <thead role="rowgroup">
            <tr role="row">
              {['Kind of task', 'Risky tasks', 'Agent directly', 'Static gate', 'Shadow Run', 'Shadow Run, rubber-stamped'].map((c) => (
                <th scope="col" role="columnheader" key={c}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {rows.map(([name, b]) => (
              <tr role="row" key={name}>
                <th scope="row" role="rowheader">
                  {(b.label ?? name).replace(/_/g, ' ')}
                </th>
                <td role="cell" data-col="Risky tasks" className="mono">
                  {num(b.direct?.risky_tasks)}
                </td>
                <td role="cell" data-col="Agent directly" className="mono">
                  {cell(b.direct?.harm_on_prod)}
                </td>
                <td role="cell" data-col="Static gate" className="mono">
                  {cell(b.static_gate?.harm_on_prod)}
                </td>
                <td role="cell" data-col="Shadow Run" className="mono">
                  {cell(b.shadow_run?.harm_on_prod)}
                </td>
                <td role="cell" data-col="Shadow Run, rubber-stamped" className="mono">
                  {cell(b.shadow_run?.harm_if_rubber_stamped)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="t-caption">{`${SOURCE} · mean per run · includes the tuning tasks, so these do not add up to the held-out figures above`}</p>
    </Fold>
  );
}

const COLUMN_NAMES = ['Metric', 'Agent directly', 'Static gate only', 'Shadow Run'];
const ROW_NAMES = [
  'Harmful outcomes on prod, risky held-out tasks',
  '...and if the approver rubber-stamps everything held',
  'Harmful outcomes on prod, risky adapted external tasks',
  '...and if the approver rubber-stamps everything held',
  'Safe tasks wrongly blocked',
  'Safe tasks that applied with no person',
  'Safe tasks held for a person',
  'Plans fixed by the retry loop',
  'Rehearsal time per attempt, p50 / p95 (s)',
  'Clone boot, p50 / p95 (ms)',
  'Inference cost per task ($)',
  'VX1 compute per rehearsal at list price ($)',
];
const COMMAND = 'bash scripts/final.sh';

/** The same drawing with nothing in it: names, dashed cells, and the command that fills them. No figure anywhere. */
function NotMeasured() {
  return (
    <div className="ev-empty">
      <Frame className="ev-empty-stage">
        <div className="ev-empty-word">
          <p className="t-display-xl t-outline">Not measured yet</p>
          <p className="ev-empty-note">The benchmark has not run. There is nothing to show until it has, and nothing here is estimated.</p>
          <div className="ev-command">
            <Label>The command that fills this page</Label>
            <span className="ev-command-line">
              <code className="mono">
                <span aria-hidden="true">$ </span>
                {COMMAND}
              </code>
              <CopyButton value={COMMAND} />
            </span>
          </div>
        </div>
        <dl className="ev-empty-tiles">
          {['Agent directly', 'Static gate', 'Shadow Run', 'Shadow Run, rubber-stamped'].map((name) => (
            <div className="ev-empty-tile" key={name}>
              <dt>{name}</dt>
              <dd>Not measured</dd>
            </div>
          ))}
        </dl>
      </Frame>
      <div className="ev-table-wrap">
        <table className="data ev-table ev-table-empty" role="table" aria-label="The benchmark table, empty until the benchmark has run">
          <thead role="rowgroup">
            <tr role="row">
              {COLUMN_NAMES.map((c) => (
                <th scope="col" role="columnheader" key={c}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup">
            {ROW_NAMES.map((name, i) => (
              <tr role="row" key={i} className={/rubber/.test(name) ? 'is-gap' : undefined}>
                <th scope="row" role="rowheader">
                  {name}
                </th>
                {COLUMN_NAMES.slice(1).map((c) => (
                  <td role="cell" key={c} data-col={c}>
                    <span className="sr-only">Not measured</span>
                    <i className="ev-dash" aria-hidden="true" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function why(data: Record<string, unknown>): ReactNode | null {
  const status = asText(data.status);
  const count = isNum(data.expected_runs) ? ` ${num(data.runs)} of ${num(data.expected_runs)} runs.` : '';
  if (status === 'running') return <>The benchmark is still running.{count} These figures can still change, so they aren't a result yet.</>;
  if (status === 'incomplete') return <>The benchmark stopped before every task was accounted for.{count} These figures aren't a result.</>;
  if (status !== 'measured') return <>The benchmark file says its status is {status || 'unknown'}, so these figures aren't a result.</>;
  if (data.scope !== 'full') return <>This run covered only part of the suite, so these figures aren't the headline.</>;
  if (isNum(data.harness_errors) && data.harness_errors > 0) return <>{num(data.harness_errors)} runs hit a harness error, so these figures aren't the headline.</>;
  return null;
}

export function ResultsPage() {
  const results = useAsync<Record<string, unknown>>(() => api.results());
  const data = results.data;
  const notMeasured = data && data.status === 'not measured yet';
  const table = data?.table as ResultsTable | undefined;
  const hasTable = !!table && Array.isArray(table.columns) && Array.isArray(table.rows);
  const notes = data?.notes;
  const rerun = typeof data?.rerun === 'string' ? data.rerun : null;
  const heldout = data?.heldout as Block | undefined;
  const external = data?.external as Block | undefined;
  const facts: [string, unknown][] = [
    ['Measured', data?.at ? whenAny(data.at) : undefined],
    ['Model', data?.model],
    ['Runs per task', data?.runs_per_task],
    ['Runs', data?.runs],
    ['Harness errors', data?.harness_errors],
    ['Commit', data?.git_commit],
    ['Scope', data?.scope],
    ['Task suite hash', data?.suite_sha256],
  ];
  const shownFacts = facts.filter(([, v]) => v !== undefined && v !== null);
  const reason = data && !notMeasured ? why(data) : null;
  const parsedAt = typeof data?.at === 'string' ? Date.parse(data.at) / 1000 : data?.at;
  const measuredAt = isNum(parsedAt) ? parsedAt : null;
  const runs = isNum(data?.runs_per_task) ? data.runs_per_task : undefined;

  return (
    <div className="page results ev-page">
      <PageHead label="Results" title="Results" lead="Benchmark results, exactly as the benchmark wrote them. This page has no numbers of its own." />
      {results.error && (
        <Notice tone="bad" title="Could not load results.">
          {results.error}
        </Notice>
      )}
      {!data && !results.error && <Loading />}
      {notMeasured && <NotMeasured />}
      {data && !notMeasured && (
        <>
          {reason && (
            <Notice tone="caution" title="Not a final result.">
              {reason}
            </Notice>
          )}
          {!reason && heldout?.direct && <Verdict held={heldout} measured={measuredAt} runs={runs} />}
          {!reason && heldout?.direct && <HarmChart block={heldout} n={2} measured={measuredAt} />}
          {!reason && heldout?.shadow_run && <GapAndPrice held={heldout} measured={measuredAt} />}
          {!reason && external?.direct && isNum(external.direct.risky_tasks) && external.direct.risky_tasks > 0 && <HarmChart block={external} n={4} measured={measuredAt} />}
          {hasTable && table ? (
            <section className="ev-table-section" aria-label="The benchmark table">
              <div className="ev-section-head">
                <Label>The whole table</Label>
                <span className="t-caption">Cell for cell from bench/results.json. Bars share one scale.</span>
              </div>
              <BenchTable table={table} colored={!reason} />
            </section>
          ) : (
            <p className="notmeasured">The response has no table to show yet. It is below as it arrived.</p>
          )}
          {!reason && data.by_group !== null && typeof data.by_group === 'object' && <ByKind groups={data.by_group as Record<string, Block>} />}
          {shownFacts.length > 0 && (
            <dl className="kvs results-facts ev-facts">
              {shownFacts.map(([k, v]) => (
                <div className="kv" key={k}>
                  <dt>{k}</dt>
                  <dd className="mono">{asText(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {rerun && (
            <div className="rerun ev-command">
              <Label>Re-run it</Label>
              <span className="ev-command-line">
                <code className="mono rerun-cmd">
                  <span aria-hidden="true">$ </span>
                  {rerun}
                </code>
                <CopyButton value={rerun} />
              </span>
            </div>
          )}
          {notes !== undefined && notes !== null && (
            <div className="results-notes">
              <h2 className="subhead">Notes</h2>
              {Array.isArray(notes) ? (
                <ul className="plainlist">
                  {notes.map((n, i) => (
                    <li key={i}>{asText(n)}</li>
                  ))}
                </ul>
              ) : (
                <p>{asText(notes)}</p>
              )}
            </div>
          )}
          <Fold summary="The raw response" open={!hasTable}>
            <pre className="inert">{JSON.stringify(data, null, 2)}</pre>
          </Fold>
        </>
      )}
    </div>
  );
}
