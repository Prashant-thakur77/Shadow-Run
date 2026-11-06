import { api } from '../api/client';
import type { Receipt } from '../api/types';
import { asText, whenAny } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { CopyButton, Loading, Mark, Notice } from '../ui/bits';
import type { Tone } from '../lib/status';

function valueText(r: Receipt): string {
  if (r.value !== undefined && r.value !== null) return asText(r.value);
  const v = r.values;
  if (Array.isArray(v)) return v.map(asText).join(', ');
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${asText(x)}`)
      .join(', ');
  }
  return asText(v);
}

/** Only words with one meaning get a colour. A figure like "0 of 3" stays plain, whichever way it reads. */
function valueTone(text: string): Tone {
  const t = text.trim().toLowerCase();
  if (['pass', 'passed', 'contained', 'blocked', 'yes', 'caught'].includes(t)) return 'good';
  if (['fail', 'failed', 'no', 'not contained', 'got through'].includes(t)) return 'bad';
  return 'neutral';
}

function Rerun({ command }: { command: string }) {
  return (
    <span className="receipt-rerun">
      <code className="mono">{command}</code>
      <CopyButton value={command} />
    </span>
  );
}

function Group({ name, items }: { name: string; items: Receipt[] }) {
  const reruns = new Set(items.map((i) => i.rerun ?? ''));
  const sources = new Set(items.map((i) => i.source ?? ''));
  const shared = reruns.size === 1 && sources.size === 1;
  return (
    <section className="receipt-group" aria-label={name}>
      <header className="receipt-group-head">
        <h2 className="section-title">{name}</h2>
        {shared && (
          <p className="receipt-group-meta">
            <span className="muted">From</span> <code className="mono">{items[0].source}</code>
            {items[0].rerun && (
              <>
                <span className="muted receipt-rerun-label">Re-run</span>
                <Rerun command={items[0].rerun} />
              </>
            )}
          </p>
        )}
      </header>
      <ul className="receipts">
        {items.map((r, i) => {
          const text = valueText(r);
          const tone = valueTone(text);
          return (
            <li className="receipt" key={`${r.claim}-${i}`}>
              <div className="receipt-claim">
                {r.claim}
                {r.detail !== undefined && r.detail !== null && <span className="receipt-detail mono">{asText(r.detail)}</span>}
                {!shared && (
                  <span className="receipt-meta">
                    <code className="mono">{r.source}</code>
                    {r.rerun && <Rerun command={r.rerun} />}
                  </span>
                )}
              </div>
              <div className="receipt-value">
                <span className={`mono receipt-word is-${tone}`}>
                  {tone !== 'neutral' && <Mark tone={tone} size={13} />} {text}
                </span>
                {r.must !== undefined && r.must !== null && <span className="muted mono receipt-must">must be {asText(r.must)}</span>}
              </div>
              <div className="receipt-at mono muted">
                {whenAny(r.at)}
                {r.commit && <span> · {r.commit.slice(0, 10)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ReceiptsPage() {
  const data = useAsync<{ items?: Receipt[]; note?: string }>(() => api.receipts());
  const items = data.data?.items ?? [];
  const groups: string[] = [];
  for (const i of items) if (!groups.includes(i.group ?? 'Other')) groups.push(i.group ?? 'Other');

  return (
    <div className="page receipts-page">
      <h1 className="page-title">Receipts</h1>
      <p className="page-lead">Every measured claim, when it was measured, the file it lives in, and the command that reproduces it.</p>
      {data.error && <Notice tone="bad" title="Could not load the receipts.">{data.error}</Notice>}
      {!data.data && !data.error && <Loading />}
      {data.data && items.length === 0 && <p className="notmeasured">{data.data.note ?? 'Nothing has been measured yet.'}</p>}
      {items.length > 0 && data.data?.note && <p className="receipts-note">{data.data.note}</p>}
      {groups.map((g) => (
        <Group key={g} name={g} items={items.filter((i) => (i.group ?? 'Other') === g)} />
      ))}
    </div>
  );
}
