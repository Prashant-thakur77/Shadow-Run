import type { CSSProperties, ReactNode } from 'react';
import { api } from '../api/client';
import type { Run } from '../api/types';
import { Link } from '../lib/router';
import type { Tone } from '../lib/status';
import { currentTarget } from '../lib/target';
import { useAsync } from '../lib/useAsync';
import { Hash, Mark } from '../ui/bits';

const MEASURED_FROM = 'Measured from the control plane, outside the sandbox.';

/** run.prod_after holds an "unavailable: ..." message when the measurement failed. */
function usable(hash?: string | null): string | null {
  return hash && !hash.startsWith('unavailable') ? hash : null;
}

// The server records prod's hash at the rehearsal and after an apply, but not just before one. A write
// in between is exactly the case a rollback is for, so this page takes that third measurement itself.
// It lasts until a reload, and the panel below says less without it.
const measuredBeforeApply = new Map<string, string>();

export async function measureProdBeforeApply(run: Run): Promise<void> {
  try {
    const { digest } = await api.prodChecksum(run.target_id ?? currentTarget());
    if (digest) measuredBeforeApply.set(run.id, digest);
  } catch {
    measuredBeforeApply.delete(run.id);
  }
}

interface HashStep {
  label: string;
  hash: string;
  /** Marks the hashes that are meant to be read as equal. */
  same?: boolean;
  caption?: string;
}

function HashPanel({ tone, word, steps, children }: { tone: Tone; word: string; steps: HashStep[]; children?: ReactNode }) {
  return (
    <section className={`prodproof tone-${tone}`} aria-label="Prod's hash">
      <div className="prodproof-word">
        <Mark tone={tone} size={30} />
        <h2>{word}</h2>
      </div>
      <ol className="prodproof-steps" style={{ '--steps': steps.length } as CSSProperties}>
        {steps.map((s) => (
          <li key={s.label} className={s.same ? 'prodproof-step is-same' : 'prodproof-step'}>
            <span className="prodproof-label">{s.label}</span>
            <Hash value={s.hash} chars={12} />
            {s.caption && <span className="prodproof-caption">{s.caption}</span>}
          </li>
        ))}
      </ol>
      {children && <p className="prodproof-note">{children}</p>}
    </section>
  );
}

function RoundTrip({ run, parent }: { run: Run; parent: Run }) {
  const before = usable(parent.prod_check?.before ?? parent.snapshot?.digest);
  const changed = usable(parent.prod_after);
  const undone = usable(run.prod_after);
  if (!before || !changed || !undone) return null;
  const back = before === undone;
  return (
    <HashPanel
      tone={back ? 'good' : 'caution'}
      word={back ? 'Prod is back where it started' : 'Prod did not return to its first hash'}
      steps={[
        { label: 'Before the change', hash: before, same: back },
        { label: 'After the change', hash: changed },
        { label: 'After the undo', hash: undone, same: back, caption: back ? 'Same as before the change' : undefined },
      ]}
    >
      {back ? MEASURED_FROM : `Something else may have written to prod between these measurements. ${MEASURED_FROM}`}
    </HashPanel>
  );
}

/** An applied undo: prod's hash before the change, after it, and after the undo. */
export function UndoRoundTrip({ run }: { run: Run }) {
  const undoOf = run.status === 'applied' ? run.undo_of : undefined;
  const parent = useAsync<Run | null>(() => (undoOf ? api.run(undoOf) : Promise.resolve(null)), [undoOf]);
  if (!undoOf || !parent.data) return null;
  return <RoundTrip run={run} parent={parent.data} />;
}

function rehearsalHash(run: Run): string | null {
  return usable(run.prod_check?.after ?? run.prod_check?.before ?? run.snapshot?.digest);
}

/** True when prod's hash after a stopped apply is not the one the rehearsal saw, which needs explaining. */
export function hashMovedSinceRehearsal(run: Run): boolean {
  const atRehearsal = rehearsalHash(run);
  const after = usable(run.prod_after);
  return !!atRehearsal && !!after && atRehearsal !== after;
}

const stopWord: Record<string, string> = { drift_detected: 'After the refusal', rolled_back: 'After the rollback' };

/** A rolled back or refused apply: what it left on prod, and why the hash may still differ from the rehearsal's. */
export function StoppedProof({ run }: { run: Run }) {
  const afterLabel = stopWord[run.status];
  const after = usable(run.prod_after);
  const atRehearsal = rehearsalHash(run);
  // A host restore that failed has left something behind, and the decision panel says so.
  if (!afterLabel || !after || !atRehearsal || run.apply?.restored === false) return null;

  const before = usable(run.prod_before_apply) ?? measuredBeforeApply.get(run.id);
  const moved = atRehearsal !== after;
  const why = moved && (
    <>
      It is not the rehearsal's hash because something outside this run wrote to prod after the rehearsal, and that is why this run stopped. The Prod chip at the top shows prod's hash right now, so it includes that write
      {run.target_id?.startsWith('demo') ? (
        <>
          {' '}
          until <Link href="/guardrails#demo">the demo is reseeded</Link>.
        </>
      ) : (
        '.'
      )}
    </>
  );

  if (before === after) {
    return (
      <HashPanel
        tone="good"
        word="This apply left prod's hash unchanged"
        steps={[
          ...(moved ? [{ label: 'At the rehearsal', hash: atRehearsal }] : []),
          { label: 'Just before the apply', hash: before, same: true },
          { label: afterLabel, hash: after, same: true, caption: 'Same as just before the apply' },
        ]}
      >
        {why || MEASURED_FROM}
      </HashPanel>
    );
  }
  if (!moved) {
    return (
      <HashPanel
        tone="good"
        word="Prod's hash is unchanged"
        steps={[
          { label: 'At the rehearsal', hash: atRehearsal, same: true },
          { label: afterLabel, hash: after, same: true, caption: 'Same as at the rehearsal' },
        ]}
      >
        {MEASURED_FROM}
      </HashPanel>
    );
  }
  return (
    <HashPanel
      tone="neutral"
      word="Prod's hash moved, but not because of this plan"
      steps={[
        { label: 'At the rehearsal', hash: atRehearsal },
        { label: afterLabel, hash: after },
      ]}
    >
      {why}
    </HashPanel>
  );
}
