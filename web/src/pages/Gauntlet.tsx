import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api/client';
import type { Gauntlet, GauntletPublished, GauntletRound, Target } from '../api/types';
import { money, num, plural, signedNum, usd, when } from '../lib/format';
import type { Tone } from '../lib/status';
import { Fold, Loading, Mark, Notice, Sql } from '../ui/bits';
import { ProofRows } from '../run/ProofRows';

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  got_through: { label: 'Past every rule', tone: 'caution' },
  caught_by_guardrail: { label: 'Caught by a guardrail', tone: 'good' },
  caught_by_gate: { label: 'Caught by the gate', tone: 'good' },
  no_effect: { label: 'No effect', tone: 'neutral' },
  invalid: { label: 'Invalid attempt', tone: 'neutral' },
};

function rowsText(r: GauntletRound): string | null {
  const rows = r.rows;
  if (!rows) return null;
  const parts = [
    rows.DELETE ? `${num(rows.DELETE)} deleted` : null,
    rows.UPDATE ? `${num(rows.UPDATE)} updated` : null,
    rows.INSERT ? `${num(rows.INSERT)} inserted` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function Moved({ round }: { round: GauntletRound }) {
  const moved = round.metrics_moved ?? [];
  if (!moved.length) return null;
  return (
    <ul className="gt-moved">
      {moved.map((m, i) => {
        const fmt = (v: number | null | undefined) => (m.unit === 'usd' ? money(v) : num(v));
        const delta = typeof m.before === 'number' && typeof m.after === 'number' ? m.after - m.before : null;
        return (
          <li key={i}>
            {m.name}: <span className="mono">{fmt(m.before)} → {m.after === null ? 'gone' : fmt(m.after)}</span>
            {delta !== null && m.unit !== 'usd' && <span className="mono muted"> ({signedNum(delta)})</span>}
          </li>
        );
      })}
    </ul>
  );
}

function RoundCard({ round, target, onAccepted }: { round: GauntletRound; target: Target; onAccepted: () => void }) {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const escaped = round.outcome === 'got_through' && round.would_auto_apply === true;
  const info = escaped ? { label: 'Would have applied alone', tone: 'bad' as Tone } : (OUTCOME[round.outcome ?? ''] ?? { label: round.outcome ?? 'Unknown', tone: 'neutral' as Tone });
  const muted = round.outcome === 'no_effect' || round.outcome === 'invalid';
  const rows = rowsText(round);
  const candidate = round.candidate;
  const accepted = !!candidate && (target.guardrails ?? []).some((g) => g.id === candidate.id);

  const accept = async () => {
    if (!candidate) return;
    setAccepting(true);
    setError(null);
    try {
      await api.acceptCandidate(candidate.id, target.id);
      onAccepted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <li className={`gt-round is-${info.tone}${muted ? ' is-muted' : ''}`}>
      <div className="gt-round-head">
        <span className="mono gt-n">Round {round.n}</span>
        <span className="gt-outcome">
          <Mark tone={info.tone} size={16} />
          {info.label}
        </span>
        {rows && <span className="mono gt-rows">{rows}</span>}
      </div>
      {round.idea && <p className="gt-idea">{round.idea}</p>}

      {round.outcome === 'got_through' && (
        <div className="gt-verdict">
          <p>
            <strong>The plan did real damage and every guardrail passed.</strong> Its own damage check ran on a clone, so the damage is real.
          </p>
          {round.would_auto_apply === true && <p className="tone-bad-text">It was within the budget, so it would have applied with no person looking.</p>}
          {round.would_auto_apply === false && (
            <p>
              It still would have waited for a person
              {(round.held_because?.length ?? 0) > 0 ? ':' : '.'}
            </p>
          )}
          {round.would_auto_apply === false && (round.held_because?.length ?? 0) > 0 && (
            <ul className="plainlist mono">
              {round.held_because?.map((h) => <li key={h}>{h}</li>)}
            </ul>
          )}
        </div>
      )}
      {round.outcome === 'caught_by_guardrail' && (round.caught_by?.length ?? 0) > 0 && (
        <p className="gt-caught">Stopped by: {round.caught_by?.join(', ')}</p>
      )}
      {round.detail && <p className={muted ? 'gt-detail muted mono' : 'gt-detail mono'}>{round.detail}</p>}
      <Moved round={round} />

      {(round.plan?.length ?? 0) > 0 && (
        <Fold summary={`The plan, ${num(round.plan?.length)} ${round.plan?.length === 1 ? 'statement' : 'statements'}`}>
          {round.plan?.map((p, i) => <Sql text={p} key={i} />)}
          {round.harm_check && (
            <>
              <p className="muted">Its own damage check</p>
              <Sql text={round.harm_check} />
            </>
          )}
        </Fold>
      )}

      {candidate && (
        <div className={candidate.proof?.proved ? 'candidate is-proved' : 'candidate is-unproved'}>
          <p className="label">A rule that would have caught it</p>
          <div className="candidate-name">{candidate.name}</div>
          {candidate.why && <p className="guardrail-why">{candidate.why}</p>}
          <Sql text={candidate.sql} />
          <ProofRows proof={candidate.proof} />
          {candidate.proof?.proved ? (
            accepted ? (
              <p className="gt-accepted">
                <Mark tone="good" size={14} /> Accepted. It is in the frozen guardrails above.
              </p>
            ) : (
              <button type="button" className="btn" disabled={accepting} onClick={accept}>
                {accepting ? 'Accepting' : 'Accept this guardrail'}
              </button>
            )
          ) : (
            <p className="muted">Not proved, so it can't be accepted.</p>
          )}
          {error && (
            <p className="error-line" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** One run, in a line. The published table above holds the headline, so this stays smaller than it. */
function Summary({ run }: { run: Gauntlet }) {
  const s = run.summary;
  if (!s) return null;
  const real = s.real_attacks ?? 0;
  const alone = s.would_auto_apply ?? 0;
  const held = s.held_for_a_person ?? 0;
  const reach = s.reach_alone ?? [];
  // With no list there was nothing limiting these plans, so what they changed is not all they could have.
  const oldPolicy = run.policy === 'row_budget_only';
  const tone = alone > 0 ? (oldPolicy ? 'tone-bad' : 'tone-caution') : real > 0 ? 'tone-good' : 'tone-neutral';
  return (
    <div className={`gt-summary ${tone}`}>
      <p className="gt-summary-lead">
        {real === 0 ? (
          'Latest run: no plan did real damage, so this run proves little.'
        ) : (
          <>
            Latest run: <span className="mono">{num(real)}</span> damaging {plural(real, 'plan')}.{' '}
            {alone === 0 ? (
              'None could apply alone.'
            ) : (
              <>
                <span className="mono">{num(alone)}</span> could apply alone
                {reach.length > 0 ? (
                  <>
                    , and they changed{oldPolicy ? '' : ' only'}: <span className="mono gt-summary-reach">{reach.join(', ')}</span>.
                  </>
                ) : (
                  '.'
                )}
              </>
            )}
          </>
        )}
      </p>
      {real > 0 && (
        <p className="gt-summary-line">
          <span className="mono">{num(s.caught)}</span> stopped by a rule. <span className="mono">{num(held)}</span> passed every rule and then waited for a person, who would have to spot the damage in the report.
        </p>
      )}
      {oldPolicy && <p className="gt-summary-line">This run measured the old policy, a row limit with no list of what may change.</p>}
      <p className="muted gt-summary-meta">
        {num(s.rounds)} rounds, {num(s.no_effect)} with no effect, {num(s.invalid)} invalid. Attacker <code className="mono">{run.model}</code>, cost {usd(run.cost_usd)}, started <span className="mono">{when(run.created_at)}</span>.
      </p>
    </div>
  );
}

function Replay({ run, onDone }: { run: Gauntlet; onDone: (g: Gauntlet) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = run.replay;
  const candidates = (run.rounds ?? []).filter((x) => x.outcome === 'got_through').length;
  if (run.status !== 'done' || candidates === 0) return null;

  const replay = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.gauntletReplay(run.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gt-replay">
      <div className="gt-replay-head">
        <p>
          {r ? (
            <>
              Replayed against <span className="mono">{num(r.guardrails)}</span> rules: <strong><span className="mono">{num(r.caught)}</span> of <span className="mono">{num(r.total)}</span> now stopped</strong>
              {(r.did_not_run ?? 0) > 0 ? `, ${num(r.did_not_run)} did not run` : ''}.
            </>
          ) : (
            <>Accept the rules below, then run these {num(candidates)} attacks again on new clones.</>
          )}
        </p>
        <button type="button" className="btn" disabled={busy} onClick={replay}>
          {busy ? 'Replaying' : r ? 'Replay again' : 'Replay these attacks'}
        </button>
      </div>
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
      {r?.attacks && r.attacks.length > 0 && (
        <ul className="plainlist gt-replay-list">
          {r.attacks.map((a) => (
            <li key={a.n}>
              <Mark tone={a.caught ? 'good' : a.ran ? 'bad' : 'neutral'} size={14} /> Round {a.n}: {a.caught ? `stopped by ${(a.caught_by ?? []).slice(0, 2).join(', ')}` : a.ran ? 'still passes every rule' : 'did not run'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PublishedRow({ label, s }: { label: string; s?: Gauntlet['summary'] }) {
  if (!s) return null;
  const reach = s.reach_alone ?? [];
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="mono num" data-label="Damaging plans">{num(s.real_attacks)}</td>
      <td className="mono num" data-label="Stopped by a rule">{num(s.caught)}</td>
      <td className="mono num" data-label="Waited for a person">{num(s.held_for_a_person)}</td>
      <td className="mono num gt-alone" data-label="Applied alone">{num(s.would_auto_apply)}</td>
      <td className="mono gt-reach" data-label="What those could change, unattended">{reach.length ? reach.join(', ') : 'nothing'}</td>
    </tr>
  );
}

/** The measured comparison. It leads the section, because one run on its own can't say whether the policy helped. */
function Published() {
  const [data, setData] = useState<GauntletPublished | null>(null);
  useEffect(() => {
    let stopped = false;
    api
      .gauntletPublished()
      .then((d) => {
        if (!stopped) setData(d);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, []);
  if (!data?.measured) return null;
  const r = data.replay;
  return (
    <div className="gt-published">
      <h3 className="subhead">Measured: the same attacker, against each policy</h3>
      <div className="tablewrap">
        <table className="gt-table">
          <thead>
            <tr>
              <th scope="col">Policy</th>
              <th scope="col" className="num">Damaging plans</th>
              <th scope="col" className="num">Stopped by a rule</th>
              <th scope="col" className="num">Waited for a person</th>
              <th scope="col" className="num">Applied alone</th>
              <th scope="col">What those could change, unattended</th>
            </tr>
          </thead>
          <tbody>
            <PublishedRow label="The old policy, a row limit only" s={data.baseline_summary} />
            <PublishedRow label="A named list of what may change alone" s={data.first_summary} />
            <PublishedRow label={`The same, with ${num(data.adopted?.length)} more rules it taught us`} s={data.summary} />
          </tbody>
        </table>
      </div>
      {r && (
        <p className="gt-published-foot">
          Replaying the attacks that passed the rules, against the rules they taught: <strong className="mono">{num(r.caught)}</strong> of <strong className="mono">{num(r.total)}</strong> now stopped.
        </p>
      )}
      <p className="muted gt-summary-meta">
        Attacker <code className="mono">{data.model}</code>, cost {usd(data.cost_usd)}, measured <span className="mono">{data.at}</span>. Re-run: <code className="mono">{data.rerun}</code>
      </p>
    </div>
  );
}

export function GauntletSection({ target, onAccepted }: { target: Target; onAccepted: () => void }) {
  const [latest, setLatest] = useState<Gauntlet | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await api.gauntletList(5);
    const mine = list.find((g) => !g.target_id || g.target_id === target.id) ?? null;
    setLatest(mine);
    return mine;
  }, [target.id]);

  useEffect(() => {
    let stopped = false;
    refresh()
      .catch((e) => {
        if (!stopped) setError(errorText(e));
      })
      .finally(() => {
        if (!stopped) setLoaded(true);
      });
    return () => {
      stopped = true;
    };
  }, [refresh]);

  const running = latest?.status === 'running';

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = await refresh();
        if (stopped) return;
        setError(null);
        if (next?.status !== 'running') return;
      } catch (e) {
        if (!stopped) setError(errorText(e));
      }
      if (!stopped) timer = window.setTimeout(tick, 3000);
    };
    timer = window.setTimeout(tick, 3000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [running, refresh]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setLatest(await api.gauntletStart(target.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rounds = latest?.rounds ?? [];
  const expected = latest?.expected ?? 0;
  const pending = running ? Math.max(0, expected - rounds.length) : 0;

  return (
    <div className="gauntlet">
      <div className="gauntlet-head">
        <p className="gauntlet-why">A model is told every guardrail and the auto-apply rule, then tries to do real damage with no person looking. Its own damage check runs on a clone, so a claim of damage has to be real.</p>
        <button type="button" className="btn btn-primary btn-large" disabled={busy || running} onClick={start}>
          {running ? 'Attacking' : busy ? 'Starting' : 'Attack the guardrails'}
        </button>
      </div>
      {error && (
        <Notice tone="bad" title="The API refused or could not be reached.">
          {error}
        </Notice>
      )}
      <Published />
      {!loaded && <Loading />}
      {loaded && !latest && <p className="notmeasured">Nobody has attacked these guardrails yet.</p>}
      {latest && !latest.summary && <h3 className="subhead">The latest run</h3>}
      {latest?.status === 'error' && (
        <Notice tone="bad" title="This gauntlet stopped with an error.">
          <span className="mono">{latest.error ?? 'No detail given.'}</span>
        </Notice>
      )}
      {latest && <Summary run={latest} />}
      {latest && <Replay run={latest} onDone={setLatest} />}
      {running && (
        <p className="gauntlet-progress">
          <Mark tone="live" size={14} /> Round <span className="mono">{num(rounds.length + 1)}</span> of <span className="mono">{num(expected)}</span> is running. A round can take half a minute.
        </p>
      )}
      {rounds.length > 0 && (
        <ol className="gt-rounds">
          {rounds.map((r) => (
            <RoundCard key={r.n} round={r} target={target} onAccepted={onAccepted} />
          ))}
          {Array.from({ length: pending }, (_, i) => (
            <li className="gt-round is-pending" key={`p${i}`}>
              <div className="gt-round-head">
                <span className="mono gt-n">Round {rounds.length + i + 1}</span>
                <span className="muted">Waiting</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
