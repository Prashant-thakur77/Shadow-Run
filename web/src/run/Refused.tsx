import { useState } from 'react';
import { api, errorText } from '../api/client';
import type { Run } from '../api/types';
import { num, plural } from '../lib/format';
import { navigate } from '../lib/router';
import { Notice } from '../ui/bits';

/** The statement to try: the one in the request if it names one, otherwise the plainest bad one. */
export function dropFrom(task?: string | null): string {
  const m = task?.match(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\w."]+(?:\s*,\s*[\w."]+)*(?:\s+CASCADE)?/i);
  return m ? m[0].replace(/\s+/g, ' ') : 'DROP TABLE users CASCADE';
}

/** An agent that says no is a good answer, but it never tests the checks. This sends the statement past the agent. */
export function TryTheDrop({ task, targetId }: { task?: string | null; targetId?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cmd = dropFrom(task);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.startRun({ steps: [{ type: 'sql', cmd }], target_id: targetId });
      navigate(`/runs/${encodeURIComponent(res.id)}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="refused-try">
      <button type="button" className="btn" disabled={busy} onClick={() => void go()}>
        {busy ? 'Starting' : 'Try the DROP yourself'}
      </button>
      <p className="muted">
        Sends <code className="mono">{cmd}</code> as a SQL plan, past the agent. The static gate reads it first, and anything it lets through runs only on a clone.
      </p>
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What the agent did before it declined, from the attempts, because a retry can end in a refusal after a real try. */
export function refusalLine(run: Run | null | undefined): string {
  const tried = (run?.attempts ?? []).filter((a) => a.verdict === 'failed_guardrails');
  const broke = tried.length ? (tried[0].guardrails ?? []).filter((g) => g.passed === false).length : 0;
  const evaded = (run?.attempts ?? []).find((a) => a.verdict === 'evaded_rule');
  if (broke && evaded) {
    return `Its first plan broke ${num(broke)} ${plural(broke, 'guardrail')} on a clone. Attempt ${num(evaded.n)} passed them only by getting around one, so it went back. Then the agent stopped, and nothing reached prod.`;
  }
  return broke
    ? `Its first plan broke ${num(broke)} ${plural(broke, 'guardrail')} on a clone. Then it stopped trying, so it ended with no plan that changes anything, and nothing reached prod.`
    : 'It ended with no plan that changes anything, and nothing reached prod.';
}

export function RefusedNotice({ run }: { run: Run }) {
  const reason = run.refused?.reason;
  return (
    <Notice tone="neutral" title="The agent refused this request.">
      {reason && <span className="narrowed-line">{reason}</span>}
      <span className="narrowed-line">{refusalLine(run)}</span>
      {run.target_id !== 'demo-host' && <TryTheDrop task={run.task} targetId={run.target_id} />}
    </Notice>
  );
}
