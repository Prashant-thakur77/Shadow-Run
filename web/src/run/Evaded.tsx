import { api } from '../api/client';
import type { Attempt, Evasion, EvasionFacts } from '../api/types';
import { num } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Notice } from '../ui/bits';

/** What the two checks for getting around a rule found, in the words a reviewer needs. */
export function EvasionLines({ evasion }: { evasion: Evasion }) {
  const read = evasion.read;
  return (
    <>
      {(evasion.rewrote ?? []).map((r) => (
        <span className="narrowed-line" key={r.rule}>
          It changes <code className="mono">{r.columns.join(', ')}</code>. The rule "{r.rule}" reads that, and the plan that broke the rule didn't change it.
        </span>
      ))}
      {read?.verdict === 'no_answer' ? (
        <span className="narrowed-line">The second model gave no answer, and no answer counts as doubt.</span>
      ) : read && read.verdict !== 'respects_it' && read.reason ? (
        <span className="narrowed-line">
          A second model, reading only the plans: {read.reason} <span className="muted">({read.model})</span>
        </span>
      ) : null}
    </>
  );
}

/** The last attempt that got around a rule. A run can end on a later attempt, such as the agent declining. */
export function evadedAttempt(attempts: Attempt[] | undefined): Attempt | undefined {
  return [...(attempts ?? [])].reverse().find((a) => a.verdict === 'evaded_rule' && a.evasion);
}

/** A plan went back to the agent because it got around a rule it had broken. */
export function EvadedNotice({ attempt }: { attempt: Attempt }) {
  return (
    <Notice tone="bad" title={`Attempt ${attempt.n} passed every guardrail by getting around one it had broken.`}>
      <EvasionLines evasion={attempt.evasion!} />
      <span className="narrowed-line">A guardrail can't see this, because the guardrail is what the plan got around. So the plan went back to the agent, and nothing reached prod.</span>
    </Notice>
  );
}

/** A plan that passed after breaking a rule, and both checks say it met the rule. The person deciding still hears what
 * plans like it did in the benchmark before the checks existed. */
export function PassedAfterBreaking({ attempts, final }: { attempts: Attempt[] | undefined; final: Attempt | null | undefined }) {
  const facts = useAsync<EvasionFacts>(() => api.evasion());
  if (!final?.evasion || final.evasion.evaded) return null;
  const broke = (attempts ?? []).filter((a) => a.n < final.n && a.verdict === 'failed_guardrails').length;
  const rates = facts.data?.rates;
  const after = rates?.passed_after_breaking_a_rule?.harmful_pct;
  const first = rates?.passed_first_time?.harmful_pct;
  return (
    <Notice tone="caution" title={`This plan passed after ${num(broke)} ${broke === 1 ? 'attempt' : 'attempts'} broke a guardrail. Read it before you sign.`}>
      <span className="narrowed-line">
        Both checks for getting around a rule say it meets the rule: the columns it changes, and a second model{final.evasion.read?.model ? ` (${final.evasion.read.model})` : ''} reading the plans.
      </span>
      {after != null && first != null ? (
        <span className="narrowed-line">
          Before these checks existed, plans that passed after breaking a rule did harm {num(after)}% of the time in the benchmark, against {num(first)}% for plans that passed first time.
        </span>
      ) : null}
    </Notice>
  );
}
