import './_styles';
import '../styles/pg-evidence.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, errorText } from '../api/client';
import type { Audit, AuditEvent } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { num, plural, short, when } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { statusInfo } from '../lib/status';
import { Hash, Loading, Mark, Notice, Tag } from '../ui/bits';
import { Caption } from '../ui/Figure';
import { Frame } from '../ui/Frame';
import { Label } from '../ui/Label';
import { Measured } from '../ui/Measured';
import { PageHead } from './_evidence';

const PAGE = 200;

// store.verify_chain() reports a break as broken_at_seq, and leaves out the head.
type Chain = NonNullable<Audit['chain']> & { broken_at_seq?: number };

// ------------------------------------------------------------------ Re-checking the chain in this browser

/** A number as the server wrote it. A parsed 2.0 would come back as 2 and hash differently. */
class RawNumber {
  constructor(public text: string) {}
}

function canonical(v: unknown): string {
  if (v instanceof RawNumber) return v.text;
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;
const parseKeepingNumbers = (text: string) => JSON.parse(text, ((_k, value, ctx) => (typeof value === 'number' && ctx?.source ? new RawNumber(ctx.source) : value)) as Reviver) as unknown;

async function sha256Hex(prev: string, body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(prev + body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface RawEvent {
  seq: RawNumber;
  run_id: unknown;
  ts: unknown;
  actor: unknown;
  type: unknown;
  detail: unknown;
  prev_sha256: string;
  sha256: string;
}

const hashOf = (e: RawEvent, prev: string) => sha256Hex(prev, canonical({ run_id: e.run_id, ts: e.ts, actor: e.actor, type: e.type, detail: e.detail }));

function browserCan(): boolean {
  if (typeof crypto === 'undefined' || !crypto.subtle) return false;
  let keeps = false;
  JSON.parse('1', ((_k, v, ctx) => {
    if (ctx?.source) keeps = true;
    return v;
  }) as Reviver);
  return keeps;
}

interface BrowserCheck {
  state: 'running' | 'done' | 'cannot' | 'failed';
  checked: number;
  matched: number;
  firstBad: number | null;
  raw: RawEvent[];
}

/** sha256(prev + canonical(body)), the same sum the server does, on the raw bytes of the events on this page. */
function useBrowserCheck(after: number | null, count: number, chain: Chain | null): BrowserCheck | null {
  const { user, tokenFor } = useAuth();
  const [check, setCheck] = useState<BrowserCheck | null>(null);
  useEffect(() => {
    if (after === null || count === 0 || !user || !chain) return;
    if (!browserCan()) {
      setCheck({ state: 'cannot', checked: 0, matched: 0, firstBad: null, raw: [] });
      return;
    }
    let stopped = false;
    (async () => {
      setCheck((c) => ({ state: 'running', checked: 0, matched: 0, firstBad: null, raw: c?.raw ?? [] }));
      try {
        const token = await tokenFor(user.username);
        const raw: RawEvent[] = [];
        // The API serves at most a thousand a time.
        for (let from = after; raw.length < count; ) {
          const res = await fetch(`/api/audit?after=${from}&limit=${Math.min(1000, count - raw.length)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
          if (!res.ok) throw new Error(String(res.status));
          const page = (parseKeepingNumbers(await res.text()) as { events?: RawEvent[] }).events ?? [];
          if (!page.length) break;
          raw.push(...page);
          from = Number(page[page.length - 1].seq.text);
        }
        let matched = 0;
        let firstBad: number | null = null;
        let previous: string | null = null;
        for (const e of raw) {
          const ok = (await hashOf(e, e.prev_sha256)) === e.sha256 && (previous === null || e.prev_sha256 === previous);
          if (ok) matched++;
          else if (firstBad === null) firstBad = Number(e.seq.text);
          previous = e.sha256;
          if (stopped) return;
        }
        setCheck({ state: 'done', checked: raw.length, matched, firstBad, raw });
      } catch {
        if (!stopped) setCheck({ state: 'failed', checked: 0, matched: 0, firstBad: null, raw: [] });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [after, count, chain, user, tokenFor]);
  return check;
}

/** The change is made to a copy, in this tab. The stored log is never written to. */
function TamperTry({ check }: { check: BrowserCheck }) {
  const [result, setResult] = useState<{ seq: number; was: string; now: string; stored: string; fresh: string; later: number; nextPrev: string | null } | null>(null);
  const first = check.raw[0];
  if (!first) return null;
  const run = async () => {
    const actor = String(first.actor) || 'x';
    // One character, flipped by one bit.
    const last = actor.charCodeAt(actor.length - 1);
    const changed = actor.slice(0, -1) + String.fromCharCode(last ^ 1);
    const fresh = await hashOf({ ...first, actor: changed }, first.prev_sha256);
    setResult({ seq: Number(first.seq.text), was: actor, now: changed, stored: first.sha256, fresh, later: check.raw.length - 1, nextPrev: check.raw[1]?.prev_sha256 ?? null });
  };
  return (
    <div className="ev-tamper">
      {!result && (
        <button type="button" className="btn" onClick={run}>
          Change one character
        </button>
      )}
      {result ? (
        <div className="ev-tamper-result" aria-live="polite">
          <p className="ev-tamper-line">
            In a copy of event <span className="mono">{result.seq}</span>, in this tab only, <code className="mono">{result.was}</code> became <code className="mono">{result.now}</code>.
          </p>
          <dl className="ev-tamper-hashes">
            <div>
              <dt>Stored hash</dt>
              <dd className="mono">{short(result.stored, 24)}</dd>
            </div>
            <div>
              <dt>Hash of the copy</dt>
              <dd className="mono">{short(result.fresh, 24)}</dd>
            </div>
          </dl>
          <p className="ev-tamper-line">
            <Mark tone="bad" size={13} /> They don't match, so the next event's link fails{result.nextPrev ? ` (it expects ${short(result.nextPrev, 12)})` : ''}. Hiding that means rewriting all <span className="mono">{num(result.later)}</span> later events on this page, and the head hash above.
          </p>
          <button type="button" className="btn btn-small" onClick={() => setResult(null)}>
            Put it back
          </button>
        </div>
      ) : (
        <p className="ev-tamper-hint">Alters a copy of the oldest event on this page, in this tab, and re-hashes it. The stored log isn't touched.</p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ The ledger

const STATUS_OF_EVENT: Record<string, string> = {
  run_blocked: 'blocked',
  apply_committed: 'applied',
  apply_rolled_back: 'rolled_back',
  apply_drift_detected: 'drift_detected',
  awaiting_approval: 'awaiting_approval',
  rejected: 'rejected',
  approved: 'approved',
};

const words = (t?: string) => (t ?? 'event').replace(/_/g, ' ');

function duration(a?: number, b?: number): string | null {
  if (a === undefined || b === undefined || a === b) return null;
  const s = Math.abs(a - b);
  if (s < 1) return `${Math.round(s * 1000)} ms`;
  if (s < 90) return `${s.toFixed(1)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** Neighbours in the log with the same run, newest first. Only neighbours, so the gutter never reorders the chain. */
function groupEvents(events: AuditEvent[]): AuditEvent[][] {
  const groups: AuditEvent[][] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && (last[0].run_id ?? null) === (e.run_id ?? null)) last.push(e);
    else groups.push([e]);
  }
  return groups;
}

function ChainLink({ prev, sha, chars = 10 }: { prev?: string; sha?: string; chars?: number }) {
  return (
    <span className="mono ev-link">
      <span title={prev}>{prev ? short(prev, chars) : 'start'}</span>
      <span className="sr-only">then</span>
      <span className="ev-link-arrow" aria-hidden="true">
        →
      </span>
      <span title={sha}>{short(sha, chars)}</span>
    </span>
  );
}

function EventRow({ e, firstBad, first }: { e: AuditEvent; firstBad: number | null; first?: number }) {
  const offset = first !== undefined && e.ts !== undefined ? duration(e.ts, first) : null;
  return (
    <li className={`ev-event${e.seq === firstBad ? ' is-first-bad' : firstBad !== null && e.seq < firstBad ? ' is-before-bad' : ''}`}>
      <span className="mono ev-seq">{e.seq}</span>
      <div className="ev-event-main">
        <div className="ev-event-head">
          <span className="ev-event-type">{words(e.type)}</span>
          {e.seq === firstBad && <Tag tone="bad">First bad event</Tag>}
          <span className="mono ev-event-meta">{e.actor}</span>
          <span className="mono ev-event-meta">
            {when(e.ts)}
            {offset && <span> · +{offset}</span>}
          </span>
          <ChainLink prev={e.prev_sha256} sha={e.sha256} />
        </div>
        <details className="ev-json">
          <summary>Detail and hashes</summary>
          <div className="ev-json-body">
            <dl className="ev-json-hashes">
              <div>
                <dt>prev</dt>
                <dd>{e.prev_sha256 ? <Hash value={e.prev_sha256} full /> : <span className="mono">the start of the log</span>}</dd>
              </div>
              <div>
                <dt>this</dt>
                <dd>
                  <Hash value={e.sha256} full />
                </dd>
              </div>
            </dl>
            <pre className="inert">{JSON.stringify(e.detail ?? null, null, 2)}</pre>
          </div>
        </details>
      </div>
    </li>
  );
}

function RunRow({ events, firstBad, open, index, total }: { events: AuditEvent[]; firstBad: number | null; open: boolean; index: number; total: number }) {
  const newest = events[0];
  const oldest = events[events.length - 1];
  const status = STATUS_OF_EVENT[newest.type ?? ''];
  const info = status ? statusInfo(status) : { label: words(newest.type), tone: 'neutral' as const };
  const span = duration(newest.ts, oldest.ts);
  const hasBad = firstBad !== null && events.some((e) => e.seq === firstBad);
  return (
    <li
      className={`ev-run${hasBad ? ' is-first-bad' : ''}${firstBad !== null && newest.seq > firstBad && !hasBad ? ' is-unverified' : ''}`}
      style={{ '--i': index, '--of': total } as CSSProperties}
    >
      <details open={open || hasBad}>
        <summary className="ev-run-row">
          <span className="mono ev-seq">{events.length > 1 ? `${oldest.seq} to ${newest.seq}` : newest.seq}</span>
          <span className="ev-run-id">
            {newest.run_id ? (
              <Link href={`/runs/${encodeURIComponent(newest.run_id)}`} className="mono">
                {newest.run_id}
              </Link>
            ) : (
              <span className="mono ev-run-none">{newest.actor}</span>
            )}
          </span>
          <span className="ev-run-status">
            <Mark tone={info.tone} size={12} />
            {info.label}
          </span>
          <span className="mono ev-run-count">
            {num(events.length)} {plural(events.length, 'event')}
            {span && ` · ${span}`}
          </span>
          <span className="mono ev-run-time">{when(newest.ts)}</span>
          <ChainLink prev={oldest.prev_sha256} sha={newest.sha256} />
          <i className="ev-chevron" aria-hidden="true" />
        </summary>
        <ol className="ev-events">
          {events.map((e) => (
            <EventRow e={e} key={e.seq} firstBad={firstBad} first={oldest.ts} />
          ))}
        </ol>
      </details>
    </li>
  );
}

export function AuditPage() {
  const { search } = useLocation();
  const runFilter = new URLSearchParams(search).get('run');
  const [chain, setChain] = useState<Chain | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [oldest, setOldest] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');

  // The API pages forward from `after`, so ask for the size first, then read the newest page.
  useEffect(() => {
    let stopped = false;
    (async () => {
      setLoading(true);
      try {
        const head = await api.audit(0, 1);
        const headChain = head.chain as Chain | undefined;
        const total = headChain?.events ?? head.events?.length ?? 0;
        const limit = runFilter ? 1000 : PAGE;
        // A broken chain counts only up to the break, so read around the break itself.
        const after = headChain?.broken_at_seq !== undefined ? Math.max(0, headChain.broken_at_seq - Math.floor(limit / 2)) : Math.max(0, total - limit);
        const page = await api.audit(after, limit);
        if (stopped) return;
        setChain((page.chain ?? head.chain ?? null) as Chain | null);
        setEvents(page.events ?? []);
        setOldest(after);
        setError(null);
      } catch (e) {
        if (!stopped) setError(errorText(e));
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [runFilter]);

  const loadOlder = async () => {
    if (oldest === null || oldest <= 0) return;
    setLoading(true);
    try {
      const after = Math.max(0, oldest - PAGE);
      const page = await api.audit(after, oldest - after);
      setEvents((prev) => [...(page.events ?? []), ...prev]);
      setOldest(after);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const check = useBrowserCheck(oldest, events.length, chain);

  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.type ?? 'event', (counts.get(e.type ?? 'event') ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [events]);
  const runIds = useMemo(() => {
    const seen = new Map<string, number>();
    for (const e of events) if (e.run_id) seen.set(e.run_id, (seen.get(e.run_id) ?? 0) + 1);
    return [...seen.entries()].reverse();
  }, [events]);

  const shown = useMemo(() => [...events].filter((e) => (!runFilter || e.run_id === runFilter) && (!typeFilter || e.type === typeFilter)).reverse(), [events, runFilter, typeFilter]);
  const groups = useMemo(() => groupEvents(shown), [shown]);
  const filtered = !!runFilter || !!typeFilter;
  const ok = chain?.ok;
  const firstBad = chain && !ok ? (chain.broken_at_seq ?? null) : null;

  // The gutter lights from the good end. On a broken chain it stops at the first bad event.
  const list = useRef<HTMLOListElement>(null);
  const [breakTop, setBreakTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const root = list.current;
    if (firstBad === null || !root) {
      setBreakTop(null);
      return;
    }
    // Rows off screen settle to their real height as they're reached, and a person can fold the run shut.
    const measure = () => {
      const open = root.querySelector<HTMLElement>('.ev-event.is-first-bad');
      const el = open && open.getClientRects().length ? open : root.querySelector<HTMLElement>('.ev-run.is-first-bad');
      setBreakTop(el ? el.getBoundingClientRect().top - root.getBoundingClientRect().top + 16 : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [firstBad, groups]);
  const lit = !!chain && !filtered && groups.length > 0;

  return (
    <div className="page audit ev-page">
      <PageHead label="Audit" title="Audit" lead="Every event carries the hash of the one before it. Changing any past event breaks the chain from there on." />

      {chain && (
        <Frame className={`ev-chainhead ${ok ? 'is-verified' : 'is-broken'}`}>
          <div className="ev-chainhead-side">
            <Label>The server walked every event</Label>
            <p className="t-display-l ev-chain-word">
              <Mark tone={ok ? 'good' : 'bad'} size={30} />
              <span>{ok ? 'Chain verified' : 'Chain broken'}</span>
            </p>
            {!ok && firstBad !== null && (
              <p className="ev-chain-why">
                The first event that doesn't verify is <span className="mono">{firstBad}</span>. Everything before it checks out, and nothing after it can be vouched for.
              </p>
            )}
          </div>
          <dl className="ev-chainhead-facts">
            <div className="ev-fact">
              <dt>{ok ? 'Events' : 'Events verified before the break'}</dt>
              <dd className="t-num-l">
                <Measured value={chain.events} format={num} source="control/store.py verify_chain" />
              </dd>
            </div>
            <div className="ev-fact">
              <dt>Head hash</dt>
              <dd>
                {chain.head ? <Hash value={chain.head} full /> : <span className="mono">None. There is no head to trust past a break.</span>}
              </dd>
            </div>
            {check && (
              <div className="ev-fact ev-fact-browser">
                <dt>Re-hashed in this browser</dt>
                <dd>
                  {check.state === 'running' && <span className="mono ev-fact-quiet">Hashing</span>}
                  {check.state === 'cannot' && <span className="ev-fact-quiet">This browser can't do this on this page. It needs https and a recent version.</span>}
                  {check.state === 'failed' && <span className="ev-fact-quiet">The events could not be read again for this check.</span>}
                  {check.state === 'done' && (
                    <>
                      <span className={`t-num-m ${check.matched === check.checked ? 'is-good' : 'is-caution'}`}>
                        <Mark tone={check.matched === check.checked ? 'good' : 'caution'} size={14} /> {num(check.matched)} of {num(check.checked)}
                      </span>
                      <span className="ev-fact-quiet">
                        {check.matched === check.checked
                          ? 'Events on this page, summed here with no help from the server.'
                          : `This tab got a different hash at event ${num(check.firstBad)}.`}
                      </span>
                    </>
                  )}
                </dd>
              </div>
            )}
          </dl>
          {check?.state === 'done' && ok && check.checked > 1 && <TamperTry check={check} />}
        </Frame>
      )}
      {chain && (
        <figure className="ev-chain-source">
          <Caption>sha256(prev + canonical(run_id, ts, actor, type, detail)) · keys sorted, no spaces · control/store.py</Caption>
        </figure>
      )}

      {error && (
        <Notice tone="bad" title="Could not load the audit log.">
          {error}
        </Notice>
      )}
      {loading && events.length === 0 && <Loading />}

      {events.length > 0 && (
        <div className="ev-filters">
          <label className="ev-filter">
            <span className="t-label">Event type</span>
            <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {types.map(([t, n]) => (
                <option key={t} value={t}>
                  {words(t)} ({num(n)})
                </option>
              ))}
            </select>
          </label>
          <label className="ev-filter">
            <span className="t-label">Run</span>
            <select className="input mono" value={runFilter ?? ''} onChange={(e) => navigate(e.target.value ? `/audit?run=${encodeURIComponent(e.target.value)}` : '/audit')}>
              <option value="">All runs</option>
              {runFilter && !runIds.some(([r]) => r === runFilter) && <option value={runFilter}>{runFilter}</option>}
              {runIds.map(([r, n]) => (
                <option key={r} value={r}>
                  {r} ({num(n)})
                </option>
              ))}
            </select>
          </label>
          <p className="ev-filters-note t-caption">
            Showing <span className="mono">{num(shown.length)}</span> of the <span className="mono">{num(events.length)}</span> newest events loaded.
            {filtered && ' The line is dashed because these events are not neighbours in the chain.'}
          </p>
        </div>
      )}

      {runFilter && (
        <p className="audit-filter">
          Showing run <Link href={`/runs/${encodeURIComponent(runFilter)}`} className="mono">{runFilter}</Link>. <Link href="/audit">Show all events</Link>
        </p>
      )}

      {!loading && shown.length === 0 && !error && <p className="notmeasured">No events to show.</p>}

      {shown.length > 0 && typeFilter && (
        <ol className={`ev-chain is-filtered`}>
          {shown.map((e) => (
            <li className="ev-run ev-run-flat" key={e.seq}>
              <ol className="ev-events">
                <EventRow e={e} firstBad={firstBad} />
              </ol>
            </li>
          ))}
        </ol>
      )}

      {shown.length > 0 && !typeFilter && (
        <ol className={`ev-chain${filtered ? ' is-filtered' : ''}${ok ? ' is-verified' : ''}${firstBad !== null ? ' is-broken' : ''}`} ref={list}>
          {lit && ok && <i className="ev-chain-line is-good" aria-hidden="true" />}
          {lit && !ok && breakTop !== null && <i className="ev-chain-line is-from-bad" style={{ top: breakTop }} aria-hidden="true" />}
          {groups.map((g, i) => (
            <RunRow key={g[0].seq} events={g} firstBad={firstBad} open={!!runFilter} index={Math.min(i, 40)} total={Math.min(groups.length, 40)} />
          ))}
        </ol>
      )}

      {oldest !== null && oldest > 0 && !runFilter && (
        <button type="button" className="btn audit-more" disabled={loading} onClick={loadOlder}>
          {loading ? 'Loading' : `Load ${num(Math.min(PAGE, oldest))} older events`}
        </button>
      )}
    </div>
  );
}
