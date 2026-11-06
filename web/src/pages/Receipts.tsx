import './_styles';
import '../styles/pg-evidence.css';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api } from '../api/client';
import type { Receipt } from '../api/types';
import { controlSplit } from '../lib/controls';
import { asText, isNum, num, plural, whenAny } from '../lib/format';
import type { Tone } from '../lib/status';
import { useAsync } from '../lib/useAsync';
import { CopyButton, Loading, Mark, Notice } from '../ui/bits';
import { Label } from '../ui/Label';
import { PageHead, useFirstSight } from './_evidence';

/** The claim's measured value as text, or null when there is no measurement. */
function valueText(r: Receipt): string | null {
  if (r.value !== undefined && r.value !== null) return asText(r.value);
  const v = r.values;
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(asText).join(', ');
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${asText(x)}`)
      .join(', ');
  }
  return asText(v);
}

/** Only words with one meaning get a colour. A figure like "0 of 3" stays plain, whichever way it reads. */
function valueTone(text: string | null): Tone {
  const t = (text ?? '').trim().toLowerCase();
  if (['pass', 'passed', 'contained', 'blocked', 'yes', 'caught'].includes(t)) return 'good';
  if (['fail', 'failed', 'no', 'not contained', 'got through'].includes(t)) return 'bad';
  return 'neutral';
}

/** Counted from the rows, never written down: "33 of 33 pass". A group with no such word just says how many. */
function tallyOf(items: Receipt[]): { text: string; tone: Tone } {
  const texts = items.map(valueText);
  const tones = texts.map(valueTone);
  const good = tones.filter((t) => t === 'good').length;
  const bad = tones.filter((t) => t === 'bad').length;
  if (items.length < 2 || good + bad === 0) return { text: `${num(items.length)} ${plural(items.length, 'claim')}`, tone: 'neutral' };
  const word = texts[tones.indexOf('good')] ?? 'passed';
  return { text: `${num(good)} of ${num(items.length)} ${word.toLowerCase()}`, tone: bad > 0 || good < items.length ? 'bad' : 'good' };
}

const slug = (name: string) => `receipts-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

function Rerun({ command }: { command: string }) {
  return (
    <span className="receipt-rerun">
      <code className="mono">{command}</code>
      <CopyButton value={command} />
    </span>
  );
}

/** "403 maker-checker: ..." into its status code and its words. */
function Got({ got }: { got: string }) {
  const m = got.match(/^(\d{3})\s+(.*)$/s);
  return (
    <span className="receipt-got">
      <span className="t-label">Server said</span>
      <span className="receipt-got-text">
        {m ? (
          <>
            <b>{m[1]}</b> {m[2]}
          </>
        ) : (
          got
        )}
      </span>
    </span>
  );
}

function Value({ r }: { r: Receipt }) {
  const text = valueText(r);
  if (text === null) return <span className="mono receipt-word receipt-none">Not measured</span>;
  const v = r.value === undefined || r.value === null ? r.values : null;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return (
      <dl className="receipt-values">
        {Object.entries(v as Record<string, unknown>).map(([k, x]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className="mono">{asText(x)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  const tone = valueTone(text);
  return (
    <span className={`mono receipt-word is-${tone}`}>
      {tone !== 'neutral' && <Mark tone={tone} size={13} />} {text}
    </span>
  );
}

function Rows({ items, shared }: { items: Receipt[]; shared: boolean }) {
  return (
    <ul className="receipts">
      {items.map((r, i) => (
        <li className="receipt" key={`${r.claim}-${i}`} style={{ '--i': Math.min(i, 11) } as CSSProperties}>
          <div className="receipt-claim">
            {r.claim}
            {r.detail !== undefined && r.detail !== null && r.detail !== '' && <span className="receipt-detail mono">{asText(r.detail)}</span>}
            {!shared && (
              <span className="receipt-meta">
                <code className="mono">{r.source}</code>
                {r.rerun && <Rerun command={r.rerun} />}
              </span>
            )}
          </div>
          <div className="receipt-value">
            <Value r={r} />
            {r.must !== undefined && r.must !== null && <span className="mono receipt-must">must be {asText(r.must)}</span>}
          </div>
          <div className="receipt-at mono">
            {r.at === undefined || r.at === null ? 'No date' : whenAny(r.at)}
            {r.commit && <span className="receipt-commit">commit {r.commit.slice(0, 10)}</span>}
          </div>
          {r.got && <Got got={r.got} />}
        </li>
      ))}
    </ul>
  );
}

function Group({ name, items }: { name: string; items: Receipt[] }) {
  const reruns = new Set(items.map((i) => i.rerun ?? ''));
  const sources = new Set(items.map((i) => i.source ?? ''));
  const shared = reruns.size === 1 && sources.size === 1;
  const tally = tallyOf(items);
  const split = controlSplit(items);
  const ref = useRef<HTMLElement>(null);
  const sight = useFirstSight(ref, { belowFold: true });
  return (
    <section className={`receipt-group is-${sight}`} aria-labelledby={`${slug(name)}-title`} id={slug(name)} ref={ref}>
      <header className="receipt-group-head">
        <h2 className="receipt-group-name" id={`${slug(name)}-title`}>
          {name}
        </h2>
        <span className="receipt-tally mono">
          {tally.tone !== 'neutral' && <Mark tone={tally.tone} size={13} />} {tally.text}
        </span>
      </header>
      {shared && (
        <p className="receipt-group-meta">
          <span className="receipt-from">
            <span className="t-label">From</span> <code className="mono">{items[0].source}</code>
          </span>
          {items[0].rerun && (
            <span className="receipt-from">
              <span className="t-label">Re-run</span> <Rerun command={items[0].rerun} />
            </span>
          )}
        </p>
      )}
      {split ? (
        <>
          <p className="receipt-split">{split.words}.</p>
          {[
            { title: 'Attacks', count: split.attacks },
            { title: 'Honest path', count: split.honest },
          ].map(
            ({ title, count }) =>
              count.total > 0 && (
                <div className="receipt-kind" key={title}>
                  <h3 className="receipt-kind-head">
                    <span>{title}</span>{' '}
                    <span className="mono">
                      {num(count.hit)} of {num(count.total)} pass
                    </span>
                  </h3>
                  <Rows items={count.rows} shared={shared} />
                </div>
              ),
          )}
        </>
      ) : (
        <Rows items={items} shared={shared} />
      )}
    </section>
  );
}

/** The newest and oldest measurement behind the strip, read from its rows. */
function span(items: Receipt[]): { first: unknown; last: unknown } | null {
  const times = items
    .map((r) => (isNum(r.at) ? r.at * 1000 : typeof r.at === 'string' ? Date.parse(r.at) : NaN))
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  return { first: Math.min(...times) / 1000, last: Math.max(...times) / 1000 };
}

/** Which group the strip has fed out to, for the index beside it. */
function useCurrentGroup(names: string[]): string | null {
  const [current, setCurrent] = useState<string | null>(null);
  const key = names.join('|');
  useEffect(() => {
    if (!key) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setCurrent(e.target.id);
      },
      { rootMargin: '-25% 0px -70% 0px' },
    );
    for (const name of key.split('|')) {
      const el = document.getElementById(slug(name));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);
  return current;
}

export function ReceiptsPage() {
  const data = useAsync<{ items?: Receipt[]; note?: string }>(() => api.receipts());
  const items = useMemo(() => data.data?.items ?? [], [data.data]);
  const groups = useMemo(() => {
    const names: string[] = [];
    for (const i of items) if (!names.includes(i.group ?? 'Other')) names.push(i.group ?? 'Other');
    return names.map((name) => ({ name, items: items.filter((i) => (i.group ?? 'Other') === name) }));
  }, [items]);
  const range = span(items);
  const current = useCurrentGroup(useMemo(() => groups.map((g) => g.name), [groups]));

  return (
    <div className="page receipts-page ev-page">
      <div className={`ev-receipts${items.length > 0 ? ' has-paper' : ''}`}>
        <div className="ev-receipts-side">
          <PageHead label="Receipts" title="Receipts" lead="Every measured claim, when it was measured, the file it lives in, and the command that reproduces it." />
          {data.error && (
            <Notice tone="bad" title="Could not load the receipts.">
              {data.error}
            </Notice>
          )}
          {!data.data && !data.error && <Loading />}
          {data.data && items.length === 0 && <p className="notmeasured">{data.data.note ?? 'Nothing has been measured yet.'}</p>}
          {groups.length > 0 && (
            <nav className="ev-index" aria-label="Groups of receipts">
              <Label>On this strip</Label>
              <ol>
                {groups.map((g) => {
                  const tally = tallyOf(g.items);
                  return (
                    <li key={g.name}>
                      <a href={`#${slug(g.name)}`} aria-current={current === slug(g.name) ? 'true' : undefined}>
                        <span>{g.name}</span>
                        <span className="mono ev-index-tally">
                          {tally.tone !== 'neutral' && <Mark tone={tally.tone} size={12} />} {tally.text}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ol>
            </nav>
          )}
        </div>
        {items.length > 0 && (
          <div className="on-paper ev-paper">
            <header className="ev-paper-head">
              <div className="ev-paper-title">
                <span className="t-display-m">Shadow Run</span>
                <span className="t-label">Measured claims</span>
              </div>
              <dl className="ev-paper-facts">
                <div>
                  <dt>Items</dt>
                  <dd className="mono">{num(items.length)}</dd>
                </div>
                {range && (
                  <>
                    <div>
                      <dt>Oldest measurement</dt>
                      <dd className="mono">{whenAny(range.first)}</dd>
                    </div>
                    <div>
                      <dt>Newest measurement</dt>
                      <dd className="mono">{whenAny(range.last)}</dd>
                    </div>
                  </>
                )}
              </dl>
              {data.data?.note && <p className="receipts-note">{data.data.note}</p>}
            </header>
            {groups.map((g) => (
              <Group key={g.name} name={g.name} items={g.items} />
            ))}
            <footer className="ev-paper-foot">
              <span className="t-label">End of strip</span>
              <span className="mono">
                {num(items.length)} {plural(items.length, 'claim')}, {num(groups.length)} {plural(groups.length, 'group')}
              </span>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
