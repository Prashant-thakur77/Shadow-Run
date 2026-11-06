import { useEffect, useMemo, useState } from 'react';
import { api, errorText, notifyProdChanged } from '../api/client';
import type { GuardrailDraft, Inspect, Target } from '../api/types';
import { asText, num } from '../lib/format';
import { orderTargets, showTarget, targetLabel } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { Fold, Hash, Loading, Mark, Notice, Section, Sql, Tag } from '../ui/bits';

const BUDGET_LABELS: Record<string, string> = {
  max_rows_changed: 'Rows changed, most',
  max_table_pct: 'Share of any table, most',
  max_cascade_rows: 'Rows via cascade, most',
  allow_drop: 'DROP allowed',
  allow_truncate: 'TRUNCATE allowed',
  allow_ddl: 'Schema changes allowed',
  max_files_deleted: 'Files deleted, most',
  max_files_changed: 'Files changed, most',
  max_services_stopped: 'Services stopped, most',
};

function budgetValue(k: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (k.endsWith('_pct')) return `${asText(v)}%`;
  return typeof v === 'number' ? num(v) : asText(v);
}

function BudgetTable({ target }: { target: Target }) {
  const entries = Object.entries(target.budget ?? {});
  return (
    <>
      <p>
        Inside these limits, a plan that passes every guardrail {target.auto_apply_within_budget ? 'applies without a person.' : 'still waits for a person.'} Outside them, a different person has to approve it.
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

function TargetDetail({ target }: { target: Target }) {
  const isHost = target.kind === 'host';
  // Schema inspection and model drafts are database features. The API answers 502 for a host.
  const inspect = useAsync<Inspect | null>(() => (isHost ? Promise.resolve(null) : api.inspect(target.id)), [target.id]);
  return (
    <>
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
          <TargetDetail key={target.id} target={target} />
        </>
      )}
    </div>
  );
}
