import { Fragment } from 'react';
import type { Run } from '../api/types';
import { short } from '../lib/format';
import { Mark } from '../ui/bits';
import type { StoryStep } from './derive';

export function AttemptsSection({
  run,
  steps,
  selected,
  onSelect,
}: {
  run: Run;
  steps: StoryStep[];
  selected: number | null;
  onSelect: (n: number) => void;
}) {
  const haveDetail = (run.attempts?.length ?? 0) > 0;
  return (
    <>
      <ol className="story">
        {steps.map((s, i) => (
          <Fragment key={s.n}>
            {i > 0 && (
              <li className="story-link" aria-hidden="true">
                <span>fed back to the agent</span>
              </li>
            )}
            <li className="story-item">
              <button
                type="button"
                className={`story-step tone-${s.tone}${selected === s.n ? ' is-on' : ''}`}
                onClick={() => onSelect(s.n)}
                disabled={!haveDetail}
                aria-pressed={selected === s.n}
              >
                <span className="story-n">Attempt {s.n}</span>
                <span className="story-verdict">
                  <Mark tone={s.tone} size={14} />
                  {s.text}
                </span>
                {s.planHash && <code className="mono story-hash">plan {short(s.planHash, 8)}</code>}
              </button>
            </li>
          </Fragment>
        ))}
      </ol>
      {haveDetail && <p className="muted">Each failure goes back to the agent with what was measured. The guardrails stay frozen, and each new plan gets a new hash. The sections below show attempt {selected}.</p>}
      {!haveDetail && <p className="muted">Full detail for each attempt appears when the run concludes.</p>}
    </>
  );
}
