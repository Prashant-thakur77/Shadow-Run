import { useEffect, useState } from 'react';
import { api, errorText } from '../api/client';
import type { Audit, AuditEvent } from '../api/types';
import { asText, num, short, when } from '../lib/format';
import { Link, useLocation } from '../lib/router';
import { Hash, Loading, Mark, Notice } from '../ui/bits';

const PAGE = 200;

export function AuditPage() {
  const { search } = useLocation();
  const runFilter = new URLSearchParams(search).get('run');
  const [chain, setChain] = useState<Audit['chain'] | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [oldest, setOldest] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The API pages forward from `after`, so ask for the size first, then read the newest page.
  useEffect(() => {
    let stopped = false;
    (async () => {
      setLoading(true);
      try {
        const head = await api.audit(0, 1);
        const total = head.chain?.events ?? head.events?.length ?? 0;
        const limit = runFilter ? 1000 : PAGE;
        const after = Math.max(0, total - limit);
        const page = await api.audit(after, limit);
        if (stopped) return;
        setChain(page.chain ?? head.chain ?? null);
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

  const shown = [...events].filter((e) => !runFilter || e.run_id === runFilter).reverse();
  const ok = chain?.ok;

  return (
    <div className="page audit">
      <h1 className="page-title">Audit</h1>
      <p className="page-lead">Every event carries the hash of the one before it. Changing any past event breaks the chain from there on.</p>

      {chain && (
        <div className={`chain ${ok ? 'is-good' : 'is-bad'}`}>
          <div className="chain-word">
            <Mark tone={ok ? 'good' : 'bad'} size={28} />
            {ok ? 'Chain verified' : 'Chain broken'}
          </div>
          <dl className="chain-facts">
            <div>
              <dt>Events</dt>
              <dd className="mono">{num(chain.events)}</dd>
            </div>
            <div>
              <dt>Head hash</dt>
              <dd>
                <Hash value={chain.head} full />
              </dd>
            </div>
          </dl>
        </div>
      )}

      {error && <Notice tone="bad" title="Could not load the audit log.">{error}</Notice>}
      {loading && events.length === 0 && <Loading />}

      {runFilter && (
        <p className="audit-filter">
          Showing run <Link href={`/runs/${encodeURIComponent(runFilter)}`} className="mono">{runFilter}</Link>. <Link href="/audit">Show all events</Link>
        </p>
      )}

      {!loading && shown.length === 0 && !error && <p className="notmeasured">No events to show.</p>}

      {shown.length > 0 && (
        <ol className="events">
          {shown.map((e) => (
            <li className="event" key={e.seq}>
              <span className="mono event-seq">{e.seq}</span>
              <div className="event-main">
                <div className="event-head">
                  <span className="event-type">{(e.type ?? 'event').replace(/_/g, ' ')}</span>
                  <span className="mono event-actor">{e.actor}</span>
                  <span className="mono muted event-time">{when(e.ts)}</span>
                  {e.run_id && (
                    <Link href={`/runs/${encodeURIComponent(e.run_id)}`} className="mono event-run">
                      {e.run_id}
                    </Link>
                  )}
                </div>
                {e.detail !== null && e.detail !== undefined && <code className="mono event-detail">{asText(e.detail)}</code>}
                <div className="mono event-chain">
                  <span title={e.prev_sha256}>prev {short(e.prev_sha256, 12)}</span>
                  <span className="arrow">→</span>
                  <span title={e.sha256}>this {short(e.sha256, 12)}</span>
                </div>
              </div>
            </li>
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
