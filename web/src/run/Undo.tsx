import { useState } from 'react';
import { api, errorText } from '../api/client';
import type { Run } from '../api/types';
import { bytes, num } from '../lib/format';
import { navigate } from '../lib/router';
import { Loading, Mark, Notice, Tag } from '../ui/bits';

const STATEMENT_PREVIEW = 600;

function capitalised(text?: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : 'The server gave no reason.';
}

function clip(sql: string): string {
  return sql.length > STATEMENT_PREVIEW ? `${sql.slice(0, STATEMENT_PREVIEW)}\n… ${num(sql.length - STATEMENT_PREVIEW)} more characters` : sql;
}

/** Statements can be very large, so they load only when asked for, and each is cut for display. */
function Statements({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const [statements, setStatements] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const isOpen = (e.target as HTMLDetailsElement).open;
    setOpen(isOpen);
    if (!isOpen || statements) return;
    try {
      const res = await api.undoStatements(run.id);
      setStatements(res.statements ?? []);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <details className="fold" onToggle={toggle}>
      <summary>The undo statements</summary>
      {open && (
        <div className="fold-body">
          {error && <Notice tone="bad" title="Could not load them.">{error}</Notice>}
          {!statements && !error && <Loading>Loading the statements</Loading>}
          {statements?.length === 0 && <p className="muted">The server has no stored statements for this run.</p>}
          {statements?.map((s, i) => (
            <pre className="sql undo-sql" key={i} tabIndex={0}>
              {clip(s)}
            </pre>
          ))}
          {statements && statements.length >= 50 && <p className="muted">The server returns the first 50.</p>}
        </div>
      )}
    </details>
  );
}

export function UndoPanel({ run }: { run: Run }) {
  const undo = run.final?.undo;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!undo) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.undo(run.id);
      navigate(`/runs/${encodeURIComponent(res.id)}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  if (undo.possible === false) {
    return (
      <div className="undo">
        <h3 className="subhead">Undo</h3>
        <p>
          <Tag tone="caution">No undo plan</Tag> {capitalised(undo.why)}
        </p>
      </div>
    );
  }

  const proved = undo.verified === true;
  return (
    <div className="undo">
      <h3 className="subhead">Undo</h3>
      <div className={proved ? 'undo-proof is-good' : 'undo-proof is-bad'}>
        <div className="undo-word">
          <Mark tone={proved ? 'good' : 'bad'} size={16} />
          {proved ? 'Undo plan proved on the clone' : 'Undo plan did not verify on the clone'}
        </div>
        <dl className="undo-counts">
          <div>
            <dt>Rows restored</dt>
            <dd className="mono">{num(undo.rows_restored)}</dd>
          </div>
          <div>
            <dt>Rows reverted</dt>
            <dd className="mono">{num(undo.rows_reverted)}</dd>
          </div>
          <div>
            <dt>Rows removed</dt>
            <dd className="mono">{num(undo.rows_removed)}</dd>
          </div>
          {undo.bytes !== undefined && (
            <div>
              <dt>Size</dt>
              <dd className="mono">{bytes(undo.bytes)}</dd>
            </div>
          )}
        </dl>
        {undo.detail && <p className="undo-detail">{capitalised(undo.detail)}.</p>}
      </div>
      {undo.too_large_to_store ? (
        <p className="muted">This undo plan was proved but is too large to store. Use the pre-apply backup instead.</p>
      ) : (
        <Statements run={run} />
      )}
      {run.status === 'applied' && !undo.too_large_to_store && (
        <div className="undo-action">
          <button type="button" className="btn" disabled={busy} onClick={start}>
            {busy ? 'Starting' : 'Undo this change'}
          </button>
          <p className="muted">An undo goes through the same pipeline as any other plan. It is frozen, rehearsed on a clone and checked against the guardrails, and it may need approval.</p>
        </div>
      )}
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
