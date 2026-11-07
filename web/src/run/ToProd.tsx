import { useState } from 'react';
import { ApiError, api, errorText } from '../api/client';
import type { Attempt, Run } from '../api/types';
import { navigate } from '../lib/router';
import { PrimaryButton } from '../ui/Halftone';
import { handOffRun } from './handoff';

function finalAttempt(run: Run | null | undefined): Attempt | null {
  return run?.attempts?.find((a) => a.n === run.final_attempt) ?? run?.final ?? null;
}

/** Only the right lane, and only a plan that passed and changes something. A plan that changes nothing has nothing to take. */
export function canTakeToProd(run: Run | null | undefined): boolean {
  const final = finalAttempt(run);
  return run?.race?.lane === 'through' && run.status === 'awaiting_approval' && final?.verdict === 'passed' && (final.plan?.steps?.length ?? 0) > 0;
}

/** Starts a normal run with the exact steps the lane ended on. The server checks they are that plan. */
export function ToProdButton({ run, className }: { run: Run; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    const steps = finalAttempt(run)?.plan?.steps ?? [];
    setBusy(true);
    setError(null);
    try {
      const res = await api.startRun({
        steps: steps.map((s) => ({ type: s.type === 'shell' ? 'shell' : 'sql', cmd: s.cmd ?? '', why: s.why })),
        target_id: run.target_id,
        from_race: run.race?.id,
      });
      handOffRun(res.id, run.task ?? '', false);
      navigate(`/runs/${encodeURIComponent(res.id)}`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? `Rate limit: ${e.message}. Nothing was started.` : errorText(e));
      setBusy(false);
    }
  };
  return (
    <>
      <PrimaryButton type="button" className={className ?? 'btn-large'} disabled={busy} onClick={() => void go()}>
        {busy ? 'Starting' : 'Take this plan to prod'}
      </PrimaryButton>
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
