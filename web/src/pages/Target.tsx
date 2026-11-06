import { useEffect, useMemo, useState } from 'react';
import { api, errorText, notifyProdChanged } from '../api/client';
import type { Guardrail, GuardrailDraft, Inspect, Target } from '../api/types';
import { asText, num } from '../lib/format';
import { orderTargets, showTarget, targetLabel } from '../lib/target';
import { Link, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { Fold, Hash, Loading, Mark, Notice, Section, Sql, Tag } from '../ui/bits';
import { ProofRows } from '../run/ProofRows';
import { GauntletSection } from './Gauntlet';

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
      <h3 className="subhead">What can change with no person looking</h3>
      <p>Only what is named here. A small change to anything else waits for a person, however few rows it touches. We added this after an attacker model, told only a row limit, damaged billing data inside that limit and passed every guardrail. A short list means safe work waits for a person too. That is the trade.</p>
      {items.length === 0 ? <p className="notmeasured">Nothing. Every change waits for a person.</p> : <ul className="plainlist mono">{items.map((i) => <li key={i}>{i}</li>)}</ul>}
    </div>
  );
}

function BudgetTable({ target }: { target: Target }) {
  const entries = Object.entries(target.budget ?? {}).filter(([k]) => k !== 'auto_apply_scope' && k !== 'auto_apply_paths');
  return (
    <>
      <AutoApplyList target={target} />
      <p>
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
      <dl className="budget">
        <div>
          <dt>MCP endpoint</dt>
          <dd className="mono">{origin}/mcp</dd>
        </div>
      </dl>
      {token ? (
        <p>
          Your token, for SHADOWRUN_TOKEN: <Hash value={token} chars={16} />
        </p>
      ) : (
        <p className="notmeasured">Sign in to see your token.</p>
      )}
      <h3 className="subhead">OpenCode on Vultr inference</h3>
      <p>Save this as opencode.json, then set VULTR_INFERENCE_KEY and SHADOWRUN_TOKEN.</p>
      <pre className="sql scroll-x">{opencode}</pre>
      <h3 className="subhead">Claude Code</h3>
      <pre className="sql scroll-x">{claude}</pre>
      <h3 className="subhead">CI</h3>
      <pre className="sql scroll-x">{`shadowrun rehearse plan.sql --target demo-saas
# exit 0 applied or nothing to do, 2 needs a person, 3 blocked, 4 rolled back or drifted`}</pre>
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
          <ul className="guardrails">
            {drafts.map((d, i) => {
              const holds = d.holds_today === true;
              return (
                <li key={d.id ?? i} className={`guardrail is-${holds ? 'good' : 'bad'}`}>
                  <div className="guardrail-state">
                    <Mark tone={holds ? 'good' : 'bad'} size={15} />
                    <span>{holds ? 'Holds today' : 'Fails today'}</span>
                  </div>
                  <div className="guardrail-main">
                    <div className="guardrail-name">{d.name ?? d.id}</div>
                    {d.why && <p className="guardrail-why">{d.why}</p>}
                    {d.error && <p className="guardrail-error mono">{d.error}</p>}
                    <Sql text={d.sql} />
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

function Schema({ data }: { data: Inspect }) {
  return (
    <>
      <p>
        <Tag tone="neutral">Served from: {data.served_from ?? 'unknown'}</Tag> Snapshot <code className="mono">{data.snapshot_id ?? 'unknown'}</code>. Schema and samples come from a clone, never from prod.
      </p>
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
      <h3 className="subhead">Tables</h3>
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
      <button type="button" className="btn" disabled={busy} onClick={reset}>
        {busy ? 'Reseeding' : target.kind === 'host' ? 'Reseed demo server' : 'Reseed demo prod'}
      </button>
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
      {proof && <ProofRows proof={proof} />}
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

/** This page is long, so its sections get links at the top. Same idea as the rail on a run page. */
function SubNav({ isHost }: { isHost: boolean }) {
  const [active, setActive] = useState('frozen');
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
    return () => io.disconnect();
  }, [isHost]);
  return (
    <nav className="subnav" aria-label="Sections of this page">
      {items.map((s) => (
        <a key={s.id} href={`#${s.id}`} className={active === s.id ? 'is-on' : undefined} aria-current={active === s.id ? 'true' : undefined}>
          {s.label}
        </a>
      ))}
    </nav>
  );
}

function TargetDetail({ target, onChanged }: { target: Target; onChanged: () => void }) {
  const isHost = target.kind === 'host';
  // Schema inspection and model drafts are database features. The API answers 502 for a host.
  const inspect = useAsync<Inspect | null>(() => (isHost ? Promise.resolve(null) : api.inspect(target.id)), [target.id]);
  return (
    <>
      <SubNav isHost={isHost} />
      <Section id="frozen" title="Frozen guardrails" aside={<span className="target-hash"><span className="label">Guardrails hash</span> <Hash value={target.guardrails_hash} chars={20} /></span>}>
        <p>
          {isHost ? 'Shell checks a plan may not break, whoever wrote it.' : 'Business rules a plan may not break, whoever wrote it.'} The agent can't edit them, and a failed one can't be approved past. Every run records this hash.
        </p>
        <ul className="guardrails">
          {(target.guardrails ?? []).map((g) => (
            <li key={g.id} className="guardrail is-neutral">
              <div className="guardrail-main guardrail-main-wide">
                <div className="guardrail-name">{g.name ?? g.id}</div>
                {g.why && <p className="guardrail-why">{g.why}</p>}
                <Sql text={g.sql ?? g.sh} plain={!g.sql} />
                {g.learned_from && <Learned from={g.learned_from} proof={g.proof} />}
                <p className="muted guardrail-who">
                  Accepted by {g.accepted_by ?? 'unknown'}
                  {g.drafted_by ? `. Drafted by ${g.drafted_by}.` : '.'}
                </p>
              </div>
            </li>
          ))}
        </ul>
        {!isHost && <Drafts target={target} />}
      </Section>

      {!isHost && (
        <Section id="gauntlet" title="Attack the guardrails" aside={<span className="muted">Published whichever way it goes</span>}>
          <GauntletSection target={target} onAccepted={onChanged} />
        </Section>
      )}

      <Section id="budget" title="Blast-radius budget">
        <BudgetTable target={target} />
      </Section>

      {!isHost && (
        <Section id="schema" title="Schema and foreign-key cascades">
          {inspect.error && <Notice tone="bad" title="Could not read the schema.">{inspect.error}</Notice>}
          {!inspect.data && !inspect.error && <Loading>Reading the schema from a clone</Loading>}
          {inspect.data && <Schema data={inspect.data} />}
        </Section>
      )}

      <Section id="connect" title="Connect an agent">
        <ConnectAgent />
      </Section>

      <Section id="demo" title="Demo controls">
        <DemoControls target={target} />
      </Section>
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
    <div className="page target">
      <h1 className="page-title">Guardrails and target</h1>
      {targets.error && <Notice tone="bad" title="Could not load the target.">{targets.error}</Notice>}
      {!targets.data && !targets.error && <Loading />}
      {targets.data && !target && <p className="notmeasured">No target is configured.</p>}
      {target && (
        <>
          <div className="target-pick">
            {list.length > 1 && (
              <div className="seg" role="group" aria-label="Target">
                {list.map((t) => (
                  <button key={t.id} type="button" className={t.id === target.id ? 'seg-btn is-on' : 'seg-btn'} aria-pressed={t.id === target.id} onClick={() => setPicked(t.id)}>
                    {targetLabel(t)}
                  </button>
                ))}
              </div>
            )}
            <p className="page-lead">
              {target.name ?? target.id} <span className="muted mono">{target.kind}</span>
            </p>
          </div>
          <TargetDetail key={target.id} target={target} onChanged={targets.reload} />
        </>
      )}
    </div>
  );
}
