import { useEffect, useState } from 'react';
import { api, errorText } from '../api/client';
import type { Candidate, Run, Target } from '../api/types';
import { usd } from '../lib/format';
import { navigate } from '../lib/router';
import { Hash, Loading, Notice, Sql } from '../ui/bits';
import { ProofRows } from './ProofRows';

export function LearnSection({ run }: { run: Run }) {
  const rejection = run.rejection?.reason ?? '';
  const [reason, setReason] = useState(rejection);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [accepted, setAccepted] = useState<Target | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [rehearsing, setRehearsing] = useState(false);

  // The run can be rejected while this is on screen. Take the reason unless someone has already typed.
  useEffect(() => {
    if (!touched && rejection) setReason(rejection);
  }, [rejection, touched]);

  const learn = async () => {
    setBusy(true);
    setError(null);
    setCandidate(null);
    setAccepted(null);
    try {
      setCandidate(await api.learn(run.id, reason));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const accept = async () => {
    if (!candidate) return;
    setAccepting(true);
    setError(null);
    try {
      setAccepted(await api.acceptCandidate(candidate.id, run.target_id ?? 'demo-saas'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAccepting(false);
    }
  };

  const rehearse = async () => {
    setRehearsing(true);
    setError(null);
    try {
      const res = await api.rehearseAgain(run.id);
      navigate(`/runs/${encodeURIComponent(res.id)}`);
    } catch (e) {
      setError(errorText(e));
      setRehearsing(false);
    }
  };

  const proved = candidate?.proof?.proved === true;

  return (
    <div className="learn">
      <p>Say why this plan is wrong. The model writes a rule, and it only counts if it passes two proofs on clones: it holds on clean data, and it catches this plan.</p>
      <label className="field">
        <span className="field-label">Why is this plan wrong?</span>
        <textarea
          className="input learn-reason"
          rows={3}
          maxLength={800}
          value={reason}
          placeholder="For example: users are soft-deleted here. Rows must never leave the users table."
          onChange={(e) => {
            setTouched(true);
            setReason(e.target.value);
          }}
        />
      </label>
      <div className="row gap-s">
        <button type="button" className="btn" disabled={busy || !reason.trim()} onClick={learn}>
          {busy ? 'Working' : candidate ? 'Try again with this reason' : 'Turn this into a guardrail'}
        </button>
      </div>
      {busy && <Loading>Writing the rule, then testing it on two clones. This can take a minute.</Loading>}
      {error && (
        <Notice tone="bad" title="That did not work.">
          {error}
        </Notice>
      )}

      {candidate && (
        <div className={proved ? 'candidate is-proved' : 'candidate is-unproved'}>
          <div className="candidate-name">{candidate.name}</div>
          {candidate.why && <p className="guardrail-why">{candidate.why}</p>}
          <Sql text={candidate.sql} />
          <ProofRows proof={candidate.proof} />
          {!proved && (
            <Notice tone="bad" title="Not proved, so it can't be accepted.">
              A rule that fails on clean data or misses this plan would make the guardrails worse. Try a more specific reason.
            </Notice>
          )}
          {proved && !accepted && (
            <div className="row gap-s">
              <button type="button" className="btn btn-primary" disabled={accepting} onClick={accept}>
                {accepting ? 'Accepting' : 'Accept this guardrail'}
              </button>
              <span className="muted candidate-cost">Writing it cost {usd(candidate.cost_usd)}.</span>
            </div>
          )}
          {accepted && (
            <>
              <Notice tone="good" title="Added to the frozen guardrails.">
                The guardrails hash changed, so every plan from now on is checked against this rule. <Hash value={accepted.guardrails_hash} chars={16} />
              </Notice>
              <div className="row gap-s">
                <button type="button" className="btn btn-primary" disabled={rehearsing} onClick={rehearse}>
                  {rehearsing ? 'Starting' : 'Rehearse this plan again'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
