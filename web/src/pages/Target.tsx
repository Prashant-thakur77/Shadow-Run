import './_styles';
import '../styles/pg-redteam-guardrails.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, errorText, notifyProdChanged } from '../api/client';
import type { GauntletPublished, Guardrail, GuardrailDraft, Inspect, Target } from '../api/types';
import { asText, num, short } from '../lib/format';
import { usePhone } from '../lib/media';
import { orderTargets, showTarget, targetLabel } from '../lib/target';
import { Link, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { CopyButton, Fold, Hash, Loading, Mark, Notice, Section, Sql, Tag } from '../ui/bits';
import { ReseedButton } from '../ui/ReseedButton';
import { asInputs, layoutRooms, type Room } from '../ui/dotfield';
import { Caption, sourceLine } from '../ui/Figure';
import { Label } from '../ui/Label';
import { GauntletSection, ProofTicks, usePublished } from './Gauntlet';

const BUDGET_LABELS: Record<string, string> = {
  max_rows_changed: 'Rows changed, most',
  max_table_pct: 'Share of any table, most',
  max_cascade_rows: 'Rows via cascade, most',
  allow_drop: 'DROP allowed alone',
  allow_truncate: 'TRUNCATE allowed alone',
  allow_ddl: 'Schema changes allowed alone',
  max_files_deleted: 'Files deleted, most',
  max_files_changed: 'Files changed, most',
  max_services_stopped: 'Services stopped, most',
};

function budgetValue(k: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (k.endsWith('_pct')) return `${asText(v)}%`;
  return typeof v === 'number' ? num(v) : asText(v);
}

function AutoApplyList({ target }: { target: Target }) {
  const budget = (target.budget ?? {}) as Record<string, unknown>;
  const scope = budget.auto_apply_scope as Record<string, string | string[]> | null | undefined;
  const paths = budget.auto_apply_paths as string[] | undefined;
  const items = scope
    ? Object.entries(scope).flatMap(([t, c]) => (c === '*' ? [`${t}, any column`] : (c as string[]).map((col) => `${t}.${col}`)))
    : (paths ?? []).map((p) => `${p}…`);
  return (
    <div className="auto-list">
      <div className="auto-list-items">
        <Label>Applies with no person</Label>
        <h3 className="auto-list-title">What can change with no person looking</h3>
        {items.length === 0 ? (
          <p className="notmeasured">Nothing. Every change waits for a person.</p>
        ) : (
          <ul className="auto-list-tokens">
            {items.map((i) => (
              <li key={i}>
                <code className="auto-token">{i}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="auto-list-why">Only what is named here. A small change to anything else waits for a person, however few rows it touches. We added this after an attacker model, told only a row limit, damaged billing data inside that limit and passed every guardrail. A short list means safe work waits for a person too. That is the trade.</p>
    </div>
  );
}

function BudgetTable({ target }: { target: Target }) {
  const entries = Object.entries(target.budget ?? {}).filter(([k]) => k !== 'auto_apply_scope' && k !== 'auto_apply_paths');
  return (
    <>
      <AutoApplyList target={target} />
      <p className="budget-lead">
        Inside these limits, a plan that passes every guardrail and stays on the list {target.auto_apply_within_budget ? 'applies without a person.' : 'still waits for a person.'} Outside them, a different person has to approve it.
      </p>
      {entries.length === 0 && <p className="notmeasured">This target has no budget set.</p>}
      <dl className="budget">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt>{BUDGET_LABELS[k] ?? k.replace(/_/g, ' ')}</dt>
            <dd className="mono">{budgetValue(k, v)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <div className="codeblock">
      <pre className="sql scroll-x" tabIndex={0}>
        {text}
      </pre>
      <CopyButton value={text} />
    </div>
  );
}

function ConnectAgent() {
  const [token, setToken] = useState<string | null>(null);
  const origin = window.location.origin;
  useEffect(() => {
    api.me().then((m) => setToken(m.token ?? null)).catch(() => setToken(null));
  }, []);
  const opencode = JSON.stringify(
    {
      provider: {
        vultr: {
          npm: '@ai-sdk/openai-compatible',
          options: { apiKey: '{env:VULTR_INFERENCE_KEY}', baseURL: 'https://api.vultrinference.com/v1' },
          models: { 'qwen3.8-27b': { name: 'Qwen 3.8 27B', tool_call: true } },
        },
      },
      model: 'vultr/qwen3.8-27b',
      mcp: { shadowrun: { type: 'remote', url: `${origin}/mcp`, enabled: true, headers: { Authorization: 'Bearer {env:SHADOWRUN_TOKEN}' } } },
      tools: { bash: false, write: false, edit: false },
    },
    null,
    2,
  );
  const claude = `claude mcp add --transport http shadowrun ${origin}/mcp --header "Authorization: Bearer $SHADOWRUN_TOKEN"`;
  return (
    <>
      <p>
        Agents connect over MCP and never get a database URL or an SSH key. They get five tools: inspect a clone, query a clone, rehearse a
        plan, read its report, and ask to apply it. A different person approves here, unless the change stays on the auto-apply list.
      </p>
      <dl className="connect-keys">
        <div>
          <dt>MCP endpoint</dt>
          <dd>
            <code className="mono">{origin}/mcp</code> <CopyButton value={`${origin}/mcp`} />
          </dd>
        </div>
        <div>
          <dt>Your token, for SHADOWRUN_TOKEN</dt>
          <dd>{token ? <Hash value={token} chars={16} /> : <span className="muted">Sign in to see your token.</span>}</dd>
        </div>
      </dl>
      <div className="connect-recipes">
        <div className="connect-recipe">
          <h3 className="subhead">OpenCode on Vultr inference</h3>
          <p>Save this as opencode.json, then set VULTR_INFERENCE_KEY and SHADOWRUN_TOKEN.</p>
          <CodeBlock text={opencode} />
        </div>
        <div className="connect-recipe">
          <h3 className="subhead">CI</h3>
          <CodeBlock
            text={`shadowrun rehearse plan.sql --target demo-saas
# exit 0 applied or nothing to do, 2 needs a person, 3 blocked, 4 rolled back or drifted`}
          />
          <h3 className="subhead">Other MCP clients</h3>
          <p>They bring their own model. This demo and the benchmark use Vultr inference only.</p>
          <CodeBlock text={claude} />
        </div>
      </div>
    </>
  );
}

function Drafts({ target }: { target: Target }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<GuardrailDraft[] | null>(null);
  const [model, setModel] = useState<string | undefined>();

  const draft = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.draftGuardrails(target.id);
      setDrafts(res.drafts ?? []);
      setModel(res.model);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drafts">
      <div className="drafts-head">
        <p>The model can propose new guardrails. Each draft is tested on a clone. A draft changes nothing until a person accepts it.</p>
        <button type="button" className="btn" disabled={busy} onClick={draft}>
          {busy ? 'Drafting' : 'Draft with the model'}
        </button>
      </div>
      {busy && <Loading>The model is drafting, then each draft runs on a clone. This can take a while.</Loading>}
      {error && <Notice tone="bad" title="Drafting failed.">{error}</Notice>}
      {drafts && drafts.length === 0 && <p className="notmeasured">The model returned no drafts.</p>}
      {drafts && drafts.length > 0 && (
        <>
          {model && (
            <p className="muted">
              Drafted by <code className="mono">{model}</code>.
            </p>
          )}
          <ul className="gr-rules">
            {drafts.map((d, i) => {
              const holds = d.holds_today === true;
              return (
                <li key={d.id ?? i} className={`gr-rule is-draft is-${holds ? 'good' : 'bad'}`}>
                  <Mark tone={holds ? 'good' : 'bad'} size={15} />
                  <div className="gr-rule-main">
                    <div className="gr-draft-state">{holds ? 'Holds today' : 'Fails today'}</div>
                    <h3 className="gr-rule-name">{d.name ?? d.id}</h3>
                    {d.why && <p className="gr-rule-why">{d.why}</p>}
                    {d.error && <p className="guardrail-error mono">{d.error}</p>}
                    <Fold summary="SQL">
                      <Sql text={d.sql} />
                    </Fold>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

interface Door {
  child: string;
  parent: string;
  onDelete: string;
  d: string;
  x: number;
  y: number;
}

/** An orthogonal path from the parent room to the child, ending on the child's wall. */
function doorPath(parent: Room, child: Room): Pick<Door, 'd' | 'x' | 'y'> {
  const ax = parent.x + parent.w / 2;
  const ay = parent.y + parent.h / 2;
  const by = child.y + child.h / 2;
  if (ax > child.x && ax < child.x + child.w) {
    const wall = ay > by ? child.y + child.h : child.y;
    return { d: `M${ax} ${ay}L${ax} ${wall}`, x: ax, y: wall };
  }
  const wall = ax < child.x ? child.x : child.x + child.w;
  return { d: `M${ax} ${ay}L${ax} ${by}L${wall} ${by}`, x: wall, y: by };
}

/** The real schema as a floor plan, the same drawing as the landing page's, with nothing happening in it. */
function SchemaPlan({ data }: { data: Inspect }) {
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const phone = usePhone();
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setBoxWidth(Math.floor(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // A phone keeps the drawing's scale and scrolls it sideways inside the figure.
  const width = phone ? 720 : boxWidth;
  const height = Math.round(width * (phone ? 0.72 : 0.5));
  const tables = data.tables ?? [];
  const layout = useMemo(() => {
    if (width < 80 || !tables.length) return null;
    return layoutRooms(asInputs(Object.fromEntries(tables.map((t) => [t.name, t.row_count ?? 0]))), width, height);
  }, [tables, width, height]);
  const doors: Door[] = (layout ? data.foreign_keys ?? [] : []).flatMap((f) => {
    const parent = layout?.rooms.find((r) => r.table === f.parent);
    const child = layout?.rooms.find((r) => r.table === f.child);
    if (!parent || !child || parent === child) return [];
    return [{ child: child.table, parent: parent.table, onDelete: (f.on_delete ?? '').toUpperCase(), ...doorPath(parent, child) }];
  });
  const cascades = doors.filter((d) => d.onDelete.includes('CASCADE')).length;
  return (
    <figure className="gr-plan">
      <div className={phone ? 'gr-plan-box scroll-x' : 'gr-plan-box'} ref={box} tabIndex={phone ? 0 : undefined}>
        {layout && (
          <svg
            className="gr-plan-svg"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="img"
            aria-label={`Floor plan of the database. ${num(tables.length)} tables as rooms whose area follows row count, and ${num(doors.length)} foreign keys as doors, ${num(cascades)} of them ON DELETE CASCADE. The same facts are in the table below.`}
          >
            <defs>
              <pattern id="gr-plan-grid" width={layout.squarePx} height={layout.squarePx} patternUnits="userSpaceOnUse">
                <path className="gr-plan-square" d={`M${layout.squarePx} 0H0V${layout.squarePx}`} fill="none" />
              </pattern>
            </defs>
            <rect width={layout.width} height={layout.height} fill="url(#gr-plan-grid)" />
            {doors.map((d) => (
              <path key={`${d.parent}-${d.child}`} className={d.onDelete.includes('CASCADE') ? 'gr-plan-door is-cascade' : 'gr-plan-door'} d={d.d} />
            ))}
            {layout.rooms.map((r) => (
              <g key={r.table}>
                <rect className="gr-plan-wall" x={r.x} y={r.y} width={r.w} height={r.h} />
                <text className="gr-plan-label" x={r.labelX} y={r.labelY}>
                  <tspan className="gr-plan-name">{r.table}</tspan>
                  <tspan className="gr-plan-rows" dx="6">
                    {num(r.rows)}
                  </tspan>
                </text>
              </g>
            ))}
            {[...new Set(doors.map((d) => d.parent))].map((table) => {
              const r = layout.rooms.find((x) => x.table === table);
              return r && <circle key={`o-${table}`} className="gr-plan-origin" cx={r.x + r.w / 2} cy={r.y + r.h / 2} r="3" />;
            })}
            {doors.map((d) => (
              <rect key={`n-${d.parent}-${d.child}`} className={d.onDelete.includes('CASCADE') ? 'gr-plan-node is-cascade' : 'gr-plan-node'} x={d.x - 3} y={d.y - 3} width="6" height="6" />
            ))}
          </svg>
        )}
      </div>
      <Caption>
        {sourceLine({ n: 3, extra: `snapshot ${short(data.snapshot_id, 12)} · served from ${data.served_from ?? 'unknown'}`, scale: layout ? `1 square = ${num(layout.squareRows)} rows` : null })}. Rooms are tables and doors are foreign keys, drawn from the parent's centre to the child's wall. Solid: ON DELETE CASCADE. Dashed: SET NULL.
      </Caption>
    </figure>
  );
}

function Schema({ data }: { data: Inspect }) {
  return (
    <>
      <p>
        <Tag tone="neutral">Served from: {data.served_from ?? 'unknown'}</Tag> Snapshot <code className="mono">{data.snapshot_id ?? 'unknown'}</code>. Schema and samples come from a clone, never from prod.
      </p>
      <SchemaPlan data={data} />
      <div className="scroll-x">
        <table className="data data-tight">
          <thead>
            <tr>
              <th scope="col">Child table</th>
              <th scope="col">Parent table</th>
              <th scope="col">On delete</th>
              <th scope="col">Constraint</th>
            </tr>
          </thead>
          <tbody>
            {(data.foreign_keys ?? []).map((f, i) => (
              <tr key={f.constraint ?? i}>
                <th scope="row" className="mono">{f.child}</th>
                <td className="mono">{f.parent}</td>
                <td className="mono nowrap">{f.on_delete}</td>
                <td className="mono">{f.constraint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="subhead gr-tables-head">Tables</h3>
      <div className="schema-tables">
        {(data.tables ?? []).map((t) => (
          <Fold
            key={t.name}
            summary={
              <>
                <span className="mono">{t.name}</span> <span className="muted mono">{num(t.row_count)} rows, {num(t.columns?.length)} columns</span>
              </>
            }
          >
            <div className="scroll-x">
              <table className="data data-tight">
                <thead>
                  <tr>
                    <th scope="col">Column</th>
                    <th scope="col">Type</th>
                    <th scope="col">Nullable</th>
                    <th scope="col">Default</th>
                  </tr>
                </thead>
                <tbody>
                  {(t.columns ?? []).map((c) => (
                    <tr key={c.name}>
                      <th scope="row" className="mono">{c.name}</th>
                      <td className="mono">{c.type}</td>
                      <td className="mono">{c.nullable}</td>
                      <td className="mono">{c.default ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(t.sample_rows?.length ?? 0) > 0 && (
              <div className="scroll-x">
                <table className="data data-tight">
                  <caption>Sample rows, from the clone</caption>
                  <thead>
                    <tr>
                      {Object.keys(t.sample_rows?.[0] ?? {}).map((k) => (
                        <th scope="col" key={k}>{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {t.sample_rows?.map((r, i) => (
                      <tr key={i}>
                        {Object.keys(t.sample_rows?.[0] ?? {}).map((k) => (
                          <td className="mono cell-clip" key={k}>{asText(r[k])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Fold>
        ))}
      </div>
    </>
  );
}

function DemoControls({ target }: { target: Target }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const reset = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.demoReset(target.id);
      setNote(target.kind === 'host' ? 'The demo server was recreated from its seed.' : 'Demo prod was reseeded.');
      notifyProdChanged();
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="democtl">
      <p>Runs and negative controls change this target. This puts it back to the seed.</p>
      <ReseedButton busy={busy} onConfirm={() => void reset()} label={target.kind === 'host' ? 'Reseed demo server' : 'Reseed demo prod'} what={target.kind === 'host' ? 'the demo server' : 'demo prod'} />
      {note && <p className="muted" role="status">{note}</p>}
    </div>
  );
}

function Learned({ from, proof }: { from: NonNullable<Guardrail['learned_from']>; proof?: Guardrail['proof'] }) {
  return (
    <div className="learned">
      <p className="learned-from">
        <Tag tone="neutral">Learned</Tag>{' '}
        {from.kind === 'gauntlet' ? (
          <>From the gauntlet, round <span className="mono">{num(from.round)}</span>. An attack got through, and this rule closes the gap.</>
        ) : from.kind === 'rejection' ? (
          <>
            From a rejected plan
            {from.run && (
              <>
                , <Link href={`/runs/${encodeURIComponent(from.run)}`} className="mono">{from.run}</Link>
              </>
            )}
            {from.rejected_by && <>, by <span className="mono">{from.rejected_by}</span></>}
            {from.reason && <>. Their reason: {from.reason}</>}
          </>
        ) : (
          <>Learned, not written by hand.</>
        )}
      </p>
      {proof && <ProofTicks proof={proof} />}
    </div>
  );
}

const SUBNAV = [
  { id: 'frozen', label: 'Frozen guardrails' },
  { id: 'gauntlet', label: 'Attack the guardrails', database: true },
  { id: 'budget', label: 'Blast-radius budget' },
  { id: 'schema', label: 'Schema', database: true },
  { id: 'connect', label: 'Connect an agent' },
  { id: 'demo', label: 'Demo controls' },
];

const pad = (n: number) => String(n).padStart(2, '0');

/** This page is long, so its sections get links. A pill travels a line beside them, the same idea as the rail on a run
 *  page. On a phone the links become a row of chips that scrolls sideways under the header. */
function SubNav({ isHost }: { isHost: boolean }) {
  const [active, setActive] = useState('frozen');
  const list = useRef<HTMLOListElement>(null);
  const items = SUBNAV.filter((s) => !isHost || !s.database);
  useEffect(() => {
    const els = SUBNAV.flatMap((s) => document.getElementById(s.id) ?? []);
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: '-35% 0px -55% 0px' },
    );
    els.forEach((el) => io.observe(el));
    // The last section may be too short to ever reach that band, so the end of the page counts as being in it.
    const atEnd = () => {
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) setActive(els[els.length - 1]?.id ?? 'frozen');
    };
    window.addEventListener('scroll', atEnd, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', atEnd);
    };
  }, [isHost]);
  const index = Math.max(0, items.findIndex((s) => s.id === active));
  // Keep the active chip in view on a phone. This moves only the row, never the page.
  useEffect(() => {
    const row = list.current;
    const chip = row?.children[index + 1] as HTMLElement | undefined;
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    row.scrollTo({ left: chip.offsetLeft - 16 });
  }, [index]);
  return (
    <nav className="gr-nav" aria-label="Sections of this page">
      <ol className="gr-nav-list" ref={list} style={{ '--active': index } as CSSProperties}>
        <li className="gr-nav-pill" aria-hidden="true" />
        {items.map((s, i) => (
          <li key={s.id}>
            <a href={`#${s.id}`} className={active === s.id ? 'gr-nav-link is-on' : 'gr-nav-link'} aria-current={active === s.id ? 'true' : undefined}>
              <span className="gr-nav-n mono" aria-hidden="true">
                {pad(i + 1)}
              </span>
              {s.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function LockGlyph() {
  return (
    <svg className="gr-lock" width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
      <path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="1" y="6" width="10" height="7.5" fill="currentColor" />
    </svg>
  );
}

/** What this target lets a plan change with no person, in `table.column` names, from its own budget. */
function autoApplyColumns(target: Target): string[] {
  const budget = (target.budget ?? {}) as Record<string, unknown>;
  const scope = budget.auto_apply_scope as Record<string, string | string[]> | null | undefined;
  return scope ? Object.entries(scope).flatMap(([t, c]) => (c === '*' ? [`${t}, any column`] : (c as string[]).map((col) => `${t}.${col}`))) : [];
}

/** The page's headline: the worst that can happen here, then what was measured. Every part is read from the data. */
function MeasuredLine({ data, target }: { data: GauntletPublished | null; target: Target }) {
  const columns = autoApplyColumns(target);
  const single = columns.length === 1 ? columns[0] : null;
  const worst = !columns.length ? (
    'With no person looking, a plan can change nothing on this demo.'
  ) : single?.endsWith('.note') ? (
    <>
      With no person looking, the worst a plan can do on this demo is write a false note in one column, <code className="mono">{single}</code>.
    </>
  ) : (
    <>
      With no person looking, the worst a plan can do on this demo is change {columns.length === 1 ? 'one column' : `these ${num(columns.length)} columns`}:{' '}
      {columns.map((t, i) => (
        <span key={t}>
          {i > 0 && ', '}
          <code className="mono">{t}</code>
        </span>
      ))}
      .
    </>
  );
  const s = data?.measured ? data.summary : null;
  const alone = s?.would_auto_apply ?? 0;
  const r = data?.measured ? data.replay : null;
  const rulesHere = target.guardrails?.length ?? 0;
  return (
    <div className="gr-worst">
      <p className="gr-worst-line">{worst}</p>
      {data?.measured && (
        <p className="gr-worst-more">
          {alone > 0 ? (
            <>
              An attacker model still got <span className="mono">{num(alone)}</span> damaging {alone === 1 ? 'plan' : 'plans'} through alone, and {alone === 1 ? 'that' : 'those'} could change only what is named above.
            </>
          ) : (
            'An attacker model got no damaging plan through alone.'
          )}
          {r && (
            <>
              {' '}
              In a separate test with <span className="mono">{num(r.guardrails)}</span> rules, <span className="mono">{num(r.caught)}</span> of <span className="mono">{num(r.total)}</span> replayed attacks are now stopped. This demo has <span className="mono">{num(rulesHere)}</span> rules, so that result is not this demo.
            </>
          )}{' '}
          <a href="#gauntlet">See the table</a>
        </p>
      )}
    </div>
  );
}

function TargetDetail({ target, onChanged }: { target: Target; onChanged: () => void }) {
  const isHost = target.kind === 'host';
  // Schema inspection and model drafts are database features. The API answers 502 for a host.
  const inspect = useAsync<Inspect | null>(() => (isHost ? Promise.resolve(null) : api.inspect(target.id)), [target.id]);
  const published = usePublished();
  const items = SUBNAV.filter((s) => !isHost || !s.database);
  const n = (id: string) => pad(items.findIndex((s) => s.id === id) + 1);
  const rules = target.guardrails ?? [];
  return (
    <>
      {!isHost && <MeasuredLine data={published.data} target={target} />}
      <div className="gr-layout">
        <SubNav isHost={isHost} />
        <div className="gr-column">
          <Section id="frozen" index={n('frozen')} title="Frozen guardrails" aside={<span className="target-hash"><span className="label">Guardrails hash</span> <Hash value={target.guardrails_hash} chars={20} /></span>}>
            <p className="gr-lead">
              <span className="mono">{num(rules.length)}</span> {isHost ? 'shell checks a plan may not break, whoever wrote it.' : 'business rules a plan may not break, whoever wrote it.'} The agent can't edit them, and a failed one can't be approved past. Every run records this hash.
            </p>
            {rules.length === 0 && <p className="notmeasured">This target has no guardrails.</p>}
            <ul className="gr-rules">
              {rules.map((g, i) => (
                <li key={g.id} className="gr-rule" style={{ '--i': Math.min(i, 12) } as CSSProperties}>
                  <LockGlyph />
                  <div className="gr-rule-main">
                    <h3 className="gr-rule-name">{g.name ?? g.id}</h3>
                    {g.why && <p className="gr-rule-why">{g.why}</p>}
                    {g.learned_from && <Learned from={g.learned_from} proof={g.proof} />}
                    <Fold summary={g.sql ? 'SQL' : 'Shell check'}>
                      <Sql text={g.sql ?? g.sh} plain={!g.sql} />
                      <p className="muted guardrail-who">
                        Accepted by {g.accepted_by ?? 'unknown'}
                        {g.drafted_by ? `. Drafted by ${g.drafted_by}.` : '.'}
                      </p>
                    </Fold>
                  </div>
                </li>
              ))}
            </ul>
            {!isHost && <Drafts target={target} />}
          </Section>

          {!isHost && (
            <Section id="gauntlet" index={n('gauntlet')} title="Attack the guardrails" aside={<span className="muted">Published whichever way it goes</span>}>
              <GauntletSection target={target} onAccepted={onChanged} published={published.data} publishedError={published.error} />
            </Section>
          )}

          <Section id="budget" index={n('budget')} title="Blast-radius budget">
            <BudgetTable target={target} />
          </Section>

          {!isHost && (
            <Section id="schema" index={n('schema')} title="Schema and foreign-key cascades">
              {inspect.error && <Notice tone="bad" title="Could not read the schema.">{inspect.error}</Notice>}
              {!inspect.data && !inspect.error && <Loading>Reading the schema from a clone</Loading>}
              {inspect.data && <Schema data={inspect.data} />}
            </Section>
          )}

          <Section id="connect" index={n('connect')} title="Connect an agent">
            <ConnectAgent />
          </Section>

          <Section id="demo" index={n('demo')} title="Demo controls">
            <DemoControls target={target} />
          </Section>
        </div>
      </div>
    </>
  );
}

export function TargetPage() {
  const targets = useAsync<Target[]>(() => api.targets());
  const list = useMemo(() => orderTargets(targets.data ?? []), [targets.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const target = list.find((t) => t.id === picked) ?? list[0];

  useEffect(() => {
    if (target) showTarget(target.id);
  }, [target?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arriving at a section link, such as "Attack the guardrails" on the home page. The section only
  // exists once the target has loaded, so this has to wait for it.
  const { search } = useLocation();
  useEffect(() => {
    if (!target || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [target?.id, search]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page target gr">
      <header className="gr-head">
        <div className="gr-head-main">
          <Label>Rules a plan can't break</Label>
          <h1 className="page-title">Guardrails and target</h1>
          {target && (
            <p className="page-lead">
              {target.name ?? target.id} <span className="muted mono">{target.kind}</span>
            </p>
          )}
        </div>
        {list.length > 1 && target && (
          <div className="seg" role="group" aria-label="Target">
            {list.map((t) => (
              <button key={t.id} type="button" className={t.id === target.id ? 'seg-btn is-on' : 'seg-btn'} aria-pressed={t.id === target.id} onClick={() => setPicked(t.id)}>
                {targetLabel(t)}
              </button>
            ))}
          </div>
        )}
      </header>
      {targets.error && <Notice tone="bad" title="Could not load the target.">{targets.error}</Notice>}
      {!targets.data && !targets.error && <Loading />}
      {targets.data && !target && <p className="notmeasured">No target is configured.</p>}
      {target && <TargetDetail key={target.id} target={target} onChanged={targets.reload} />}
    </div>
  );
}
