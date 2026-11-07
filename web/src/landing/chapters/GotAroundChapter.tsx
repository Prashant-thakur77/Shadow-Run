import type { EvasionFacts } from '../../api/types';
import { num } from '../../lib/format';
import { GotAround } from '../../ui/GotAround';
import { Link } from '../../lib/router';
import { ChapterHead } from './parts';

/** The finding the benchmark turned up, with the plans as recorded. Nothing shows until bench/evasion.json exists. */
export function GotAroundChapter({ facts }: { facts: EvasionFacts | null }) {
  if (!facts?.examples?.length) return null;
  const after = facts.rates?.passed_after_breaking_a_rule?.harmful_pct;
  const first = facts.rates?.passed_first_time?.harmful_pct;
  return (
    <section className="ch ch-flow" id="got-around" aria-labelledby="got-around-title">
      <div className="ch-inner">
        <ChapterHead
          id="got-around-title"
          label="What the benchmark found"
          title="Told which rule it broke, the agent sometimes gets around it."
          lead={
            <>
              Shadow Run tells the agent which guardrail its plan broke, so it can write a better one. Some of the new plans got past the rule without meeting it. They did harm{' '}
              <span className="mono">{num(after)}%</span> of the time, against <span className="mono">{num(first)}%</span> for plans that passed first time. So a plan that follows a broken rule now gets two more checks.
            </>
          }
        />
        <GotAround facts={facts} />
        <Link className="ch-more" href="/results#got-around">
          The full numbers
        </Link>
      </div>
    </section>
  );
}
