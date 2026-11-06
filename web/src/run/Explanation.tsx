import type { Attempt, Run } from '../api/types';
import { Mark } from '../ui/bits';

export function ExplanationSection({ run, attempt }: { run: Run; attempt: Attempt }) {
  const e = attempt.explanation;
  if (!e?.text) return <p className="notmeasured">The model wrote no explanation for this attempt.</p>;
  const model = run.usage?.find((u) => u.phase === 'explainer')?.model;
  const unverified = e.unverified_numbers ?? [];
  return (
    <>
      <p className="commentary-label">
        Model commentary{model ? <>, from <code className="mono">{model}</code></> : null}. {e.note ?? 'It decides nothing.'}
      </p>
      <blockquote className="commentary">{e.text}</blockquote>
      {e.numbers_verified === false ? (
        <p className="numflag">
          <Mark tone="caution" size={15} />
          <span>
            Contains numbers not in the measurements: <code className="mono">{unverified.join(', ') || 'not listed'}</code>
          </span>
        </p>
      ) : e.numbers_verified === true ? (
        <p className="muted">Every number it states appears in the measurements.</p>
      ) : null}
    </>
  );
}
