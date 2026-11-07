import '../styles/got-around.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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

/** Marks the ladder seen once it's mostly on screen, so the stamp prints once. Reduced motion shows it at once in CSS. */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

function Ladder({ example, stamp }: { example: Example; stamp: boolean }) {
  const last = example.attempts[example.attempts.length - 1];
  const [ref, seen] = useSeen<HTMLLIElement>();
  return (
    <ol className="ga-ladder">
      {example.attempts.map((a) => (
        <li className={`ga-step is-${stepTone(a)}${a === last && stamp ? ' has-stamp' : ''}${a === last && seen ? ' is-seen' : ''}`} key={a.n} ref={a === last ? ref : undefined}>
          <span className="ga-n">Attempt {a.n}</span>
          <span className="ga-what">{stepWords(a)}</span>
          {a.plan?.length ? <code className="ga-plan">{a.plan.join('\n')}</code> : <span className="ga-plan is-empty">no steps</span>}
          {a.broke?.length ? <span className="ga-broke">{a.broke.join(' · ')}</span> : null}
          {a === last && example.harm?.length ? (
            <span className="ga-harm">
              <Mark tone="bad" size={14} /> The benchmark's own check, run after approving it: {example.harm.join(', ')}.
            </span>
          ) : null}
          {a === last && stamp ? (
            <span className="ga-stamp" aria-hidden="true">
              Got around a rule
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
export function GotAround({ facts, source, head, compact = false }: { facts: EvasionFacts; source?: string; head?: ReactNode; compact?: boolean }) {
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
      <div className="ga-grid">
        {example && (
          <div className="ga-example">
            {head}
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
            <Ladder example={example} stamp={example.attempts[example.attempts.length - 1]?.verdict === 'passed'} key={shown} />
            <Caught example={example} />
          </div>
        )}
        <dl className="ga-tiles">
          {after?.harmful_pct != null && first?.harmful_pct != null && (
            <div className="ga-tile is-bad">
              <dd className="t-num-m">
                {num(after.harmful_pct)}% <span className="ga-vs">vs</span> {num(first.harmful_pct)}%
              </dd>
              <dt>of risky plans did harm when they passed only after breaking a rule, against plans that passed first time.</dt>
              <span className="t-caption">
                {num(after.plans)} and {num(first.plans)} plans{facts.rates?.safe_plans ? ` · no safe plan ever broke a rule first` : ''} · bench/evasion.json
              </span>
            </div>
          )}
          {design?.harmful?.total ? (
            <div className="ga-tile is-good">
              <dd className="t-num-m">{pair(unseen?.harmful)}</dd>
              <dt>harmful plans the new check caught, among plans it had never seen.</dt>
              <span className="t-caption">{pair(design.harmful)} on the plans it was written from · bench/evasion.json</span>
            </div>
          ) : null}
          {design?.good?.total ? (
            <div className="ga-tile">
              <dd className="t-num-m">{pair(unseen?.good)}</dd>
              <dt>good plans it sent back by mistake, among the same unseen plans. The agent tries again, or the run stops.</dt>
              <span className="t-caption">{pair(design.good)} on the others · bench/evasion.json</span>
            </div>
          ) : null}
          {!compact && empty?.plans ? (
            <div className="ga-tile">
              <dd className="t-num-m">
                {num(empty.harmful)} <span className="ga-vs">to</span> {num(empty.good)}
              </dd>
              <dt>harmful to good, when an agent that returned no steps was told to return at least one. Now no steps can be a refusal, and it isn't pushed.</dt>
              <span className="t-caption">{num(empty.plans)} plans · bench/evasion.json</span>
            </div>
          ) : null}
        </dl>
      </div>
      <p className="t-caption ga-source">
        {source ?? 'bench/evasion.json'} · replayed on runs recorded before the check · the unseen plans reuse the same tasks on a stricter schema · second model{' '}
        <span className="mono">{facts.model}</span>
      </p>
    </div>
  );
}
