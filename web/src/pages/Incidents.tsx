import './_styles';
import '../styles/pg-evidence.css';
import { useMemo, useState, type CSSProperties } from 'react';
import { api, errorText } from '../api/client';
import type { Incident, Receipt } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { asText, num, whenAny } from '../lib/format';
import { matches, REDUCED } from '../lib/media';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { CopyButton, Loading, Notice } from '../ui/bits';
import { Frame } from '../ui/Frame';
import { Label } from '../ui/Label';
import { Measured } from '../ui/Measured';
import { Stamp } from '../ui/Stamp';
import { PageHead } from './_evidence';

// The incident the landing page opens with, so the two pages tell the same story first.
const LEAD = 'saastr_freeze';

/** Letters resolve in a fixed scatter on hover, once, at most 450 ms. Names only: never a command or a number. */
function DecodedName({ text, play }: { text: string; play: number }) {
  if (play === 0) return <>{text}</>;
  const total = Math.min(450, text.length * 18);
  let index = 0;
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true" key={play}>
        {text.split(/(\s+)/).map((word, w) =>
          /^\s+$/.test(word) ? (
            ' '
          ) : (
            <span className="ev-dc-word" key={w}>
              {[...word].map((char, c) => {
                index++;
                const delay = ((index * 7919) % 97) / 97;
                return (
                  <span className={/[A-Za-z]/.test(char) ? 'ev-dc' : undefined} key={c} style={{ animationDelay: `${Math.round(delay * total)}ms` }}>
                    {char}
                  </span>
                );
              })}
            </span>
          ),
        )}
      </span>
    </>
  );
}

/** "21201 order_items deleted via cascade (step 1)" into its figure and its words. The receipt's text, unchanged. */
function parseDetail(detail: unknown): { figure: number | null; text: string }[] {
  return asText(detail)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(.*)$/s);
      const words = (m ? m[2] : line).replace(/\b\d{4,}\b/g, (d) => num(Number(d)));
      return { figure: m ? Number(m[1]) : null, text: words };
    });
}

function Measurement({ receipt, loading, failed, lead }: { receipt: Receipt | undefined; loading: boolean; failed: boolean; lead: boolean }) {
  if (loading) return <p className="ev-measure-note">Loading the measurement</p>;
  if (failed) return <p className="ev-measure-note">The measurement could not be loaded.</p>;
  if (!receipt) return <p className="ev-measure-none">Not measured yet</p>;
  const verdict = asText(receipt.value);
  const lines = parseDetail(receipt.detail);
  return (
    <div className="ev-measure">
      <div className="ev-measure-head">
        <Label>Measured on a clone</Label>
        <Stamp tone={verdict === 'blocked' ? 'good' : 'neutral'}>{verdict}</Stamp>
      </div>
      {lines.length > 0 ? (
        <ul className="ev-measure-lines">
          {lines.map((l) => (
            <li key={l.text}>
              {l.figure !== null && <Measured value={l.figure} format={num} source={receipt.source} className={`ev-figure ${lead ? 't-num-l' : 't-num-m'}`} />}
              <span className="ev-figure-words">{l.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ev-measure-why">No rows or files to count. This command reaches outside the target, so a clone can't show what it would have done. It failed there and the plan was blocked.</p>
      )}
    </div>
  );
}

function IncidentRow({
  incident,
  index,
  lead,
  receipt,
  loading,
  failed,
  running,
  setRunning,
}: {
  incident: Incident;
  index: number;
  lead: boolean;
  receipt: Receipt | undefined;
  loading: boolean;
  failed: boolean;
  running: string | null;
  setRunning: (id: string | null) => void;
}) {
  const { user, enterAsGuest } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [play, setPlay] = useState(0);
  const busy = running === incident.id;

  const replay = async () => {
    setRunning(incident.id);
    setError(null);
    try {
      // Reading is public. Running something needs an identity, and the open demo gives one.
      if (!user) await enterAsGuest();
      const res = await api.replayIncident(incident.id);
      navigate(`/runs/${encodeURIComponent(res.id)}`);
    } catch (e) {
      setError(errorText(e));
      setRunning(null);
    }
  };

  const decodeOnce = () => {
    if (!matches(REDUCED)) setPlay((p) => p + 1);
  };

  return (
    <li
      className={`incident ev-row${lead ? ' is-lead' : ''}${busy ? ' is-starting' : ''}`}
      style={{ '--i': Math.min(index, 11) } as CSSProperties}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') decodeOnce();
      }}
    >
      <div className="ev-story">
        <div className="ev-story-top">
          <span className="t-label">{String(index + 1).padStart(2, '0')}</span>
          <span className="t-label incident-when">{incident.when}</span>
        </div>
        <h2 className={`incident-title ${lead ? 't-display-l' : 'ev-title-s'}`}>
          <DecodedName text={incident.who ?? ''} play={play} />
        </h2>
        <p className="incident-what">{incident.happened}</p>
        {incident.adapted && <p className="incident-adapted">{incident.adapted}</p>}
        {incident.source && (
          <a className="ev-source" href={incident.source} target="_blank" rel="noreferrer">
            The source
          </a>
        )}
      </div>
      <div className="ev-proof">
        <div className="ev-bar">
          <Label>Command</Label>
          <span className="t-caption incident-target">target {incident.target}</span>
        </div>
        <pre className="sql incident-command" style={busy ? { viewTransitionName: 'plan-block' } : undefined}>
          <span aria-hidden="true" className="ev-prompt">
            ${' '}
          </span>
          {incident.command?.trimEnd()}
        </pre>
        <Measurement receipt={receipt} loading={loading} failed={failed} lead={lead} />
        <div className="incident-foot">
          <button type="button" className={`btn ${lead ? 'btn-primary btn-large' : ''}`} disabled={running !== null} onClick={replay}>
            {busy ? 'Starting' : 'Replay on a clone'}
          </button>
        </div>
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}
        <i className="ev-scan" aria-hidden="true" />
      </div>
    </li>
  );
}

export function IncidentsPage() {
  const incidents = useAsync<Incident[]>(() => api.incidents());
  const receipts = useAsync<{ items?: Receipt[] }>(() => api.receipts());
  const [running, setRunning] = useState<string | null>(null);

  const replays = useMemo(() => (receipts.data?.items ?? []).filter((r) => r.group === 'Incident replay'), [receipts.data]);
  const ordered = useMemo(() => {
    const list = incidents.data ?? [];
    return [...list.filter((i) => i.id === LEAD), ...list.filter((i) => i.id !== LEAD)];
  }, [incidents.data]);
  const blocked = replays.filter((r) => r.value === 'blocked').length;
  const first = replays[0];

  return (
    <div className="page incidents ev-page">
      <PageHead
        label="Incidents"
        title="Real incidents, replayed"
        lead="Each of these happened to someone. Replaying one runs the same kind of command on a disposable clone, and measures what it would have done."
        aside={
          replays.length > 0 && (
            <dl className="ev-tally">
              <div>
                <dd className="t-num-l">
                  <Measured value={`${num(blocked)} of ${num(replays.length)}`} source={first.source} />
                </dd>
                <dt>replays blocked</dt>
              </div>
              <div className="ev-tally-source">
                <p className="t-caption">
                  {first.source} · measured {whenAny(first.at)}
                </p>
                {first.rerun && (
                  <span className="ev-rerun">
                    <code className="mono">{first.rerun}</code>
                    <CopyButton value={first.rerun} />
                  </span>
                )}
              </div>
            </dl>
          )
        }
      />
      {incidents.error && (
        <Notice tone="bad" title="Could not load the incidents.">
          {incidents.error}
        </Notice>
      )}
      {!incidents.data && !incidents.error && <Loading />}
      {incidents.data?.length === 0 && <p className="notmeasured">No incidents are listed.</p>}
      {ordered.length > 0 && (
        <Frame className="ev-ledger">
          <ol className="incident-list">
            {ordered.map((i, n) => (
              <IncidentRow
                key={i.id}
                incident={i}
                index={n}
                lead={i.id === LEAD || (n === 0 && !ordered.some((x) => x.id === LEAD))}
                receipt={replays.find((r) => r.claim === `${i.who}, ${i.when}`)}
                loading={!receipts.data && !receipts.error}
                failed={!!receipts.error}
                running={running}
                setRunning={setRunning}
              />
            ))}
          </ol>
        </Frame>
      )}
    </div>
  );
}
