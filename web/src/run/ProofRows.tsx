import type { Proof } from '../api/types';
import { CheckRow } from '../ui/bits';

/** The proofs a learned guardrail has to pass before it can be accepted. */
export function ProofRows({ proof }: { proof?: Proof | null }) {
  return (
    <ul className="proofrows">
      <CheckRow ok={proof?.holds_on_clean_clone} label={proof?.holds_on_clean_clone ? 'Pass' : 'Fail'}>
        Holds on a clean clone
        {proof?.clean_error && <code className="mono proof-error">{proof.clean_error}</code>}
      </CheckRow>
      <CheckRow ok={proof?.catches_the_plan} label={proof?.catches_the_plan ? 'Pass' : 'Fail'}>
        Catches this plan
        {proof?.plan_error && <code className="mono proof-error">{proof.plan_error}</code>}
      </CheckRow>
      {proof?.allows_normal_work !== undefined && proof?.allows_normal_work !== null && (
        <CheckRow ok={proof.allows_normal_work} label={proof.allows_normal_work ? 'Pass' : 'Fail'}>
          Lets a team's normal changes through
        </CheckRow>
      )}
    </ul>
  );
}
