import '../styles/got-around.css';
import { useState } from 'react';
import type { EvasionFacts } from '../api/types';
import { num } from '../lib/format';
import { Mark } from './bits';
import { Label } from './Label';

type Example = NonNullable<EvasionFacts['examples']>[number];
type Step = Example['attempts'][number];

/** What each recorded attempt was, in words. The plans and rule names are printed exactly as the benchmark kept them. */
function stepWords(a: Step): string {
  switch (a.verdict) {
    case 'failed_guardrails':
      return `Broke ${a.broke?.length ?? 0} ${a.broke?.length === 1 ? 'guardrail' : 'guardrails'}`;
    case 'passed':
      return 'Passed every guardrail';
    case 'invalid_plan':
      return 'Returned no steps, and was told to return at least one';
    case 'sql_error':
      return 'Failed on the clone with an error';
    case 'blocked_by_gate':
      return 'Refused by the static gate';
    case 'read_only_plan':
      return 'Only read data';
    default:
      return (a.verdict ?? '').replace(/_/g, ' ');
  }
}

const stepTone = (a: Step) => (a.verdict === 'passed' ? 'bad' : a.verdict === 'failed_guardrails' ? 'caution' : 'neutral');

function Ladder({ example }: { example: Example }) {
  const last = example.attempts[example.attempts.length - 1];
  return (
    <ol className="ga-ladder">
      {example.attempts.map((a) => (
        <li className={`ga-step is-${stepTone(a)}`} key={a.n}>
          <span className="ga-n">Attempt {a.n}</span>
          <span className="ga-what">{stepWords(a)}</span>
          {a.plan?.length ? <code className="ga-plan">{a.plan.join('\n')}</code> : <span className="ga-plan is-empty">no steps</span>}
          {a.broke?.length ? <span className="ga-broke">{a.broke.join(' · ')}</span> : null}
          {a === last && example.harm?.length ? (
            <span className="ga-harm">
              <Mark tone="bad" size={14} /> The benchmark's own check, run after approving it: {example.harm.join(', ')}.
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Which of the two checks catches this plan today. Never the model's wording, which can be wrong about the SQL. */
function Caught({ example }: { example: Example }) {
  const measured = example.measured?.length;
  return (
    <p className="ga-caught">
      <Mark tone="good" size={14} />
      {measured
        ? `Shadow Run now sends this back: it changes a column that "${example.measured![0]}" reads, which the plan that broke that rule didn't change.`
        : 'Shadow Run now sends this back: a second model, reading only the plans, says it gets around the rule instead of meeting it.'}
    </p>
  );
}

const pair = (c: { caught?: number; total?: number } | undefined) => `${num(c?.caught)} of ${num(c?.total)}`;

/** The finding, its examples and what the check costs. Every number is read from bench/evasion.json. */
export function GotAround({ facts, source }: { facts: EvasionFacts; source?: string }) {
  const examples = facts.examples ?? [];
  const [shown, setShown] = useState(0);
  const after = facts.rates?.passed_after_breaking_a_rule;
  const first = facts.rates?.passed_first_time;
  const design = facts.detection?.design;
  const unseen = facts.detection?.unseen;
  const empty = facts.empty_plans;
  const example = examples[Math.min(shown, examples.length - 1)];
  return (
    <div className="ga">
      {example && (
        <div className="ga-example">
          {examples.length > 1 && (
            <div className="ga-tabs" role="tablist" aria-label="Recorded examples">
              {examples.map((e, i) => (
                <button key={`${e.task}-${i}`} type="button" role="tab" aria-selected={i === shown} className={`ga-tab${i === shown ? ' is-on' : ''}`} onClick={() => setShown(i)}>
                  Example {i + 1}
                </button>
              ))}
            </div>
          )}
          <p className="ga-request">
            <Label>The request</Label>
            <span>{example.request}</span>
          </p>
          <Ladder example={example} />
          <Caught example={example} />
        </div>
      )}
      <dl className="ga-tiles">
        {after?.harmful_pct != null && first?.harmful_pct != null && (
          <div className="ga-tile is-bad">
            <dd className="t-num-m">
              {num(after.harmful_pct)}% <span className="ga-vs">vs</span> {num(first.harmful_pct)}%
            </dd>
            <dt>
              of risky plans did harm when they passed only after breaking a rule ({num(after.plans)} plans), against plans that passed first time ({num(first.plans)}).
              {facts.rates?.safe_plans ? ` None of the ${num(facts.rates.safe_plans)} safe plans ever broke a rule first.` : ''}
            </dt>
          </div>
        )}
        {design?.harmful?.total ? (
          <div className="ga-tile is-good">
            <dd className="t-num-m">{pair(unseen?.harmful)}</dd>
            <dt>
              harmful plans the check catches on plans nobody read while writing it. On the plans it was written from: {pair(design.harmful)}.
            </dt>
          </div>
        ) : null}
        {design?.good?.total ? (
          <div className="ga-tile">
            <dd className="t-num-m">{pair(unseen?.good)}</dd>
            <dt>
              good plans it sends back by mistake on the unseen plans, and {pair(design.good)} on the others. That's its cost: the agent tries again, or the run stops.
            </dt>
          </div>
        ) : null}
        {empty?.plans ? (
          <div className="ga-tile">
            <dd className="t-num-m">
              {num(empty.harmful)} <span className="ga-vs">to</span> {num(empty.good)}
            </dd>
            <dt>
              harmful to good, when an agent that returned no steps was told to return at least one. Now no steps can be a refusal, and it isn't pushed.
            </dt>
          </div>
        ) : null}
      </dl>
      <p className="t-caption ga-source">
        {source ?? 'bench/evasion.json'} · replayed on runs recorded before the check · the unseen plans reuse the same tasks on a stricter schema · second model{' '}
        <span className="mono">{facts.model}</span>
      </p>
    </div>
  );
}
