import { useMemo, useRef } from 'react';
import type { Receipt } from '../../api/types';
import { whenAny } from '../../lib/format';
import { Frame } from '../../ui/Frame';
import { Stamp } from '../../ui/Stamp';
import { useLanding } from '../context';
import { ChapterHead, groupOf, parseGot, useReveal } from './parts';

// These three tell the story. If the receipts change, any other refusals will do.
const PREFERRED = ['Requester approves their own run', 'Approval with a changed plan hash', 'Replay the same approval'];

export function TryToBreak({ receipts, loading }: { receipts: Receipt[] | undefined; loading: boolean }) {
  const { guestOff, busy, enter } = useLanding();
  const ref = useRef<HTMLDivElement>(null);
  const live = useReveal(ref);

  const refusals = useMemo(() => {
    const controls = groupOf(receipts, 'Negative controls');
    const refused = controls.flatMap((r) => {
      const got = parseGot(r.got);
      return got && got.code.startsWith('4') ? [{ claim: r.claim ?? '', ...got, at: r.at }] : [];
    });
    const first = PREFERRED.flatMap((claim) => refused.filter((r) => r.claim === claim));
    return [...first, ...refused.filter((r) => !first.includes(r))].slice(0, 3);
  }, [receipts]);

  return (
    <section className="ch ch-screen" id="break" aria-labelledby="break-title">
      <div className="ch-inner ch-split">
        <div className="break-text">
          <ChapterHead id="break-title" label="Try to break it" title="It says no, and says why." lead="These requests were sent to the real API. The replies are the server's own words." />
          {!guestOff && (
            <button type="button" className="break-link" disabled={busy} onClick={() => void enter()}>
              Now try it yourself.
            </button>
          )}
        </div>
        <Frame className={`terminal${live ? ' is-live' : ''}`}>
          <div ref={ref} className="terminal-body">
            {refusals.length === 0 && !loading && <p className="t-display-m">Not measured yet</p>}
            {refusals.map((r, i) => (
              <div className="refusal" key={r.claim} style={{ '--i': i } as React.CSSProperties}>
                <p className="refusal-req">
                  <span aria-hidden="true">&gt; </span>
                  {r.claim}
                </p>
                <div className="refusal-reply">
                  <Stamp tone="good">Refused {r.code}</Stamp>
                  <p className="refusal-text">{r.text}</p>
                </div>
              </div>
            ))}
          </div>
          {refusals[0]?.at && <p className="t-caption terminal-caption">bench/controls.json · measured {whenAny(refusals[0].at)}</p>}
        </Frame>
      </div>
    </section>
  );
}
