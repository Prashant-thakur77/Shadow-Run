import { useMemo, useRef, useState } from 'react';
import type { Incident, Market, Receipt } from '../../api/types';
import { asText, whenAny } from '../../lib/format';
import { Link } from '../../lib/router';
import { Mark } from '../../ui/bits';
import { Frame } from '../../ui/Frame';
import { useScrub } from '../../ui/useScrub';
import { ChapterHead, groupOf, pad, Pager, Segments, useMode } from './parts';

// Chosen because each has a measured result worth showing.
const CHOSEN = ['saastr_freeze', 'supabase_ticket', 'antigravity_cache'];

/** The statement breaks up and resolves letter by letter. It lasts 18 ms a character, at most 450 ms.
 *  The real text is the label. The exact command sits below it and never animates. */
function Statement({ text }: { text: string }) {
  const words = text.split(/(\s+)/);
  const total = Math.min(450, text.length * 18);
  let index = 0;
  return (
    <p className="t-display-l stmt" key={text}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, w) =>
          /^\s+$/.test(word) ? (
            ' '
          ) : (
            <span className="stmt-word" key={w}>
              {[...word].map((char, c) => {
                index++;
                // A fixed scatter, so it resolves the same way every time.
                const delay = ((index * 7919) % 97) / 97;
                return (
                  <span className="stmt-char" key={c} style={{ animationDelay: `${Math.round(delay * total)}ms` }}>
                    {char}
                  </span>
                );
              })}
            </span>
          ),
        )}
      </span>
    </p>
  );
}

function Result({ receipt }: { receipt: Receipt | undefined }) {
  if (!receipt) return <p className="stmt-result-none">Not measured yet</p>;
  const value = asText(receipt.value);
  const lines = asText(receipt.detail)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <div className="stmt-result">
      <div className="stmt-result-head">
        <span className="t-label">Measured on a clone</span>
        <span className="stmt-verdict">
          <Mark tone={value === 'blocked' ? 'good' : 'neutral'} size={13} />
          {value}
        </span>
      </div>
      {lines.length > 0 ? (
        <ul className="stmt-lines">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="stmt-lines">It reaches outside the target, so on a clone with no network it failed. There was nothing to measure.</p>
      )}
      <p className="t-caption">
        {receipt.source} · measured {whenAny(receipt.at)}
      </p>
    </div>
  );
}

function Slide({ incident, receipt }: { incident: Incident; receipt: Receipt | undefined }) {
  return (
    <div className="stmt-slide">
      <div className="stmt-hot">
        <Statement text={incident.command ?? ''} />
        <code className="stmt-exact">
          <span aria-hidden="true">$ </span>
          {incident.command}
        </code>
      </div>
      <div className="stmt-cold">
        <div className="stmt-who">
          <h3 className="t-h3">{incident.who}</h3>
          <span className="t-caption">{incident.when}</span>
        </div>
        <p className="stmt-happened">{incident.happened}</p>
        {incident.source && (
          <a className="stmt-source" href={incident.source} target="_blank" rel="noreferrer">
            The source
          </a>
        )}
        <Result receipt={receipt} />
      </div>
    </div>
  );
}

export function HasHappened({ incidents, receipts, loading, market }: { incidents: Incident[] | null; receipts: Receipt[] | undefined; loading: boolean; market?: Market | null }) {
  const mode = useMode();
  const ref = useRef<HTMLElement>(null);
  const [index, setIndex] = useState(0);
  const chosen = useMemo(() => CHOSEN.map((id) => incidents?.find((i) => i.id === id)).filter((i): i is Incident => !!i), [incidents]);
  const replays = groupOf(receipts, 'Incident replay');
  const receiptOf = (i: Incident) => replays.find((r) => r.claim === `${i.who}, ${i.when}`);

  useScrub(ref, {
    disabled: mode !== 'pinned',
    onProgress: (p) => {
      const next = Math.min(Math.max(chosen.length, 1) - 1, Math.floor(p * Math.max(chosen.length, 1)));
      setIndex((prev) => (prev === next ? prev : next));
    },
  });

  const ai = market?.agent_incidents;
  const head = (
    <ChapterHead
      id="happened-title"
      label="It has happened"
      title="Real commands. Real systems."
      lead={
        ai?.unexpected_or_unauthorized_pct ? (
          <>
            <span className="mono hh-stat">{ai.unexpected_or_unauthorized_pct}%</span> of the professionals {ai.source?.split(',')[0]} surveyed in October 2026 confirmed or suspected an AI agent acting unexpectedly or without authorization. Only{' '}
            <span className="mono hh-stat">{ai.can_stop_automatically_pct}%</span> could stop one automatically.{' '}
            {ai.url && (
              <a href={ai.url} target="_blank" rel="noreferrer">
                The survey
              </a>
            )}
          </>
        ) : undefined
      }
    />
  );
  const none = !loading && chosen.length === 0;

  if (mode !== 'pinned' || none) {
    return (
      <section className="ch ch-flow" id="happened" aria-labelledby="happened-title">
        <div className="ch-inner">
          {head}
          {none && <p className="ch-empty t-display-m">Not measured yet</p>}
          {mode === 'pager' && !none && (
            <Pager label="Three incidents" count={chosen.length}>
              {chosen.map((i) => (
                <div className="pager-page" key={i.id}>
                  <Slide incident={i} receipt={receiptOf(i)} />
                </div>
              ))}
            </Pager>
          )}
          {mode === 'flat' &&
            chosen.map((i) => (
              <Frame className="stmt-frame" key={i.id}>
                <Slide incident={i} receipt={receiptOf(i)} />
              </Frame>
            ))}
          <Link className="ch-more" href="/incidents">
            All the incidents, replayed
          </Link>
        </div>
      </section>
    );
  }

  const current = chosen[index];
  return (
    <section className="ch ch-pin" id="happened" aria-labelledby="happened-title" ref={ref} style={{ height: '170vh' }}>
      <div className="ch-stage ch-stage-happened">
        {head}
        <Frame className="stmt-frame">{current && <Slide key={current.id} incident={current} receipt={receiptOf(current)} />}</Frame>
        <footer className="ch-foot">
          <span className="t-label ch-count">
            {pad(index + 1)} / {pad(Math.max(chosen.length, 1))}
          </span>
          <Segments count={Math.max(chosen.length, 1)} index={index} />
          <Link className="ch-more" href="/incidents">
            All the incidents, replayed
          </Link>
        </footer>
      </div>
    </section>
  );
}
