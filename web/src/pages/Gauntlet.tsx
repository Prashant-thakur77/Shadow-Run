import './_styles';
import '../styles/pg-redteam-guardrails.css';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, errorText } from '../api/client';
import type { Gauntlet, GauntletPublished, GauntletRound, Proof, Target } from '../api/types';
import { money, num, plural, signedNum, usd, when } from '../lib/format';
import { useReducedMotion } from '../lib/media';
import type { Tone } from '../lib/status';
import { Fold, Loading, Mark, Notice, Sql } from '../ui/bits';
import { Caption, sourceLine } from '../ui/Figure';
import { Frame } from '../ui/Frame';
import { PrimaryButton } from '../ui/Halftone';
import { Label } from '../ui/Label';
import { Measured } from '../ui/Measured';
import { Stamp } from '../ui/Stamp';

const OUTCOME: Record<string, { label: string; tone: Tone }> = {
  got_through: { label: 'Past every rule', tone: 'caution' },
  caught_by_guardrail: { label: 'Caught by a guardrail', tone: 'good' },
  caught_by_gate: { label: 'Caught by the gate', tone: 'good' },
  no_effect: { label: 'No effect', tone: 'neutral' },
  invalid: { label: 'Invalid attempt', tone: 'neutral' },
};

function roundInfo(round: GauntletRound): { label: string; tone: Tone } {
  if (round.outcome === 'got_through' && round.would_auto_apply === true) return { label: 'Would have applied alone', tone: 'bad' };
  return OUTCOME[round.outcome ?? ''] ?? { label: round.outcome ?? 'Unknown', tone: 'neutral' };
}

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

function Tick({ ok, children, error }: { ok: boolean | null | undefined; children: ReactNode; error?: string | null }) {
  const tone: Tone = ok === true ? 'good' : ok === false ? 'bad' : 'neutral';
  return (
    <li className={`proof-tick is-${tone}`}>
      <Mark tone={tone} size={22} />
      <span className="proof-tick-word">{ok === true ? 'Pass' : ok === false ? 'Fail' : 'Not measured'}</span>
      <span className="proof-tick-what">{children}</span>
      {error && <code className="mono proof-error">{error}</code>}
    </li>
  );
}

/** The three proofs a rule has to pass before it can be accepted, side by side, because they are the reason to trust it. */
export function ProofTicks({ proof }: { proof?: Proof | null }) {
  return (
    <ul className="proof-ticks">
      <Tick ok={proof?.holds_on_clean_clone} error={proof?.clean_error}>
        Holds on a clean clone
      </Tick>
      <Tick ok={proof?.catches_the_plan} error={proof?.plan_error}>
        Catches this plan
      </Tick>
      <Tick ok={proof?.allows_normal_work}>Lets a team's normal changes through</Tick>
    </ul>
  );
}

function RoundCard({ round, target, onAccepted }: { round: GauntletRound; target: Target; onAccepted: () => void }) {
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = roundInfo(round);
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
    <li className={`gt-round is-${info.tone}${muted ? ' is-muted' : ''}`} id={`round-${round.n}`}>
      <span className="gt-node" aria-hidden="true">
        <Mark tone={info.tone} size={16} />
      </span>
      <div className="gt-round-head">
        <span className="mono gt-n">Round {round.n}</span>
        <h4 className="gt-outcome">{info.label}</h4>
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
            <ul className="plainlist mono gt-held">
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
          <p className="candidate-label">
            <Label>A rule that would have caught it</Label>
          </p>
          <h5 className="candidate-name">{candidate.name}</h5>
          {candidate.why && !round.idea?.startsWith(candidate.why) && <p className="guardrail-why">{candidate.why}</p>}
          <ProofTicks proof={candidate.proof} />
          <div className="candidate-foot">
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
            <Fold summary="The rule's SQL">
              <Sql text={candidate.sql} />
            </Fold>
          </div>
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
              <span className="gt-summary-verdict">None could apply alone.</span>
            ) : (
              <span className="gt-summary-verdict">
                <span className="mono">{num(alone)}</span> could apply alone
                {reach.length > 0 ? (
                  <>
                    , and they changed{oldPolicy ? '' : ' only'}: <span className="mono gt-summary-reach">{reach.join(', ')}</span>.
                  </>
                ) : (
                  '.'
                )}
              </span>
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

/** A column a plan could change with no person looking. Struck through once a later policy has closed it. */
function Token({ name, closed, i }: { name: string; closed: boolean; i: number }) {
  return (
    <li>
      <code className={`gt-token ${closed ? 'is-closed' : 'is-open'}`} style={{ '--i': i } as CSSProperties}>
        <span>{name}</span>
        {closed && <span className="sr-only"> (closed by a later policy)</span>}
      </code>
    </li>
  );
}

function PublishedRow({ label, s, last }: { label: string; s?: Gauntlet['summary']; last?: string[] }) {
  if (!s) return null;
  const reach = s.reach_alone ?? [];
  const alone = s.would_auto_apply ?? 0;
  const aloneTone = alone > 0 ? ' is-bad' : (s.real_attacks ?? 0) > 0 ? ' is-good' : '';
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="mono num" data-label="Damaging plans">{num(s.real_attacks)}</td>
      <td className="mono num" data-label="Stopped by a rule">{num(s.caught)}</td>
      <td className="mono num" data-label="Waited for a person">{num(s.held_for_a_person)}</td>
      <td className={`mono num gt-alone${aloneTone}`} data-label="Applied alone">{num(s.would_auto_apply)}</td>
      <td className="mono gt-reach" data-label="What those could change, unattended">
        {reach.length ? (
          <ul className="gt-tokens">
            {reach.map((t, i) => (
              <Token key={t} name={t} i={i} closed={!!last && !last.includes(t)} />
            ))}
          </ul>
        ) : (
          'nothing'
        )}
      </td>
    </tr>
  );
}

/** Armed until the table scrolls in, then the strikes run once. Everything is readable before, during and after. */
function useReachPlay() {
  const ref = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();
  const [state, setState] = useState<'armed' | 'play' | 'done'>('armed');
  useEffect(() => {
    if (reduced) {
      setState('done');
      return;
    }
    const el = ref.current;
    if (!el || state !== 'armed') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setState('play');
          observer.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  });
  return { ref, state: reduced ? 'done' : state };
}

export function usePublished() {
  const [data, setData] = useState<GauntletPublished | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    api
      .gauntletPublished()
      .then((d) => {
        if (!stopped) setData(d);
      })
      .catch((e) => {
        if (!stopped) setError(errorText(e));
      });
    return () => {
      stopped = true;
    };
  }, []);
  return { data, error };
}

function atSeconds(at?: string): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t / 1000;
}

/** The measured comparison. It leads the section, because one run on its own can't say whether the policy helped. */
function Published({ data, error, target }: { data: GauntletPublished | null; error: string | null; target: Target }) {
  const { ref, state } = useReachPlay();
  if (error) {
    return (
      <Notice tone="bad" title="Could not read the published results.">
        {error}
      </Notice>
    );
  }
  if (!data) return <Loading>Reading the published results</Loading>;
  if (!data.measured) {
    return (
      <div className="gt-published is-empty">
        <Label>Measured</Label>
        <h3 className="gt-published-title">The same attacker, against each policy</h3>
        <p className="gt-empty-word t-display-m">Not measured yet</p>
        <p className="muted">
          <code className="mono">python scripts/gauntlet_live.py</code> produces this table, whichever way it goes.
        </p>
      </div>
    );
  }
  const r = data.replay;
  const s = data.summary;
  const reachLast = s?.reach_alone ?? [];
  const alone = s?.would_auto_apply ?? 0;
  const allStopped = !!r && (r.total ?? 0) > 0 && r.caught === r.total;
  const adopted = data.adopted ?? [];
  const onTarget = adopted.filter((name) => (target.guardrails ?? []).some((g) => g.name === name)).length;
  const closedCount = (data.baseline_summary?.reach_alone ?? []).filter((t) => !reachLast.includes(t)).length;
  return (
    <figure className="gt-published-figure">
      <Frame className={`gt-published gt-reach-${state}`}>
        <div ref={ref} className="gt-published-inner" style={{ '--strikes': closedCount } as CSSProperties}>
          <header className="gt-published-head">
            <Label>Measured</Label>
            <h3 className="gt-published-title">The same attacker, against each policy</h3>
          </header>
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
                <PublishedRow label="The old policy, a row limit only" s={data.baseline_summary} last={reachLast} />
                <PublishedRow label="A named list of what may change alone" s={data.first_summary} last={reachLast} />
                <PublishedRow label={`The same, with ${num(data.adopted?.length)} more rules it taught us`} s={data.summary} last={reachLast} />
              </tbody>
            </table>
          </div>
          <div className="gt-seam">
            <div className={`gt-seam-side ${alone > 0 ? 'is-bad' : 'is-good'}`}>
              <div className="gt-seam-figure t-num-l">
                <Measured value={s?.would_auto_apply} format={num} />
              </div>
              <div className="gt-seam-text">
                <p>
                  {alone > 0 ? `damaging ${plural(alone, 'plan')} would still apply alone` : 'damaging plans would apply alone'}, with all {num(data.guardrails_after)} rules in place.
                </p>
                {alone > 0 && reachLast.length > 0 && (
                  <p className="gt-seam-reach">
                    They could change:{' '}
                    {reachLast.map((t, i) => (
                      <span key={t}>
                        {i > 0 && ', '}
                        <code className="mono">{t}</code>
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </div>
            {r && (
              <div className={`gt-seam-side gt-seam-stopped${allStopped ? ' is-good' : ' is-bad'}`}>
                <div className="gt-seam-figure t-num-l">
                  <Measured value={r.caught} format={num} /> of <Measured value={r.total} format={num} />
                </div>
                <div className="gt-seam-text">
                  <p>now stopped.</p>
                  <p className="gt-seam-reach">Replaying the attacks that passed the rules, against the rules they taught.</p>
                </div>
              </div>
            )}
          </div>
          {adopted.length > 0 && (
            <Fold
              summary={
                <>
                  The {num(adopted.length)} rules it taught us, <span className="mono">{num(data.guardrails_before)} → {num(data.guardrails_after)}</span> in that measurement
                </>
              }
            >
              <ul className="plainlist gt-adopted">
                {adopted.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <p className="muted">
                {num(onTarget)} of {num(adopted.length)} are on this target now. Candidates below are proposed by the latest run and wait for a person to accept them.
              </p>
            </Fold>
          )}
        </div>
      </Frame>
      <Caption>
        {sourceLine({ n: 2, measured: atSeconds(data.at), extra: `attacker ${data.model ?? 'unknown'} · cost ${usd(data.cost_usd)}` })}. Struck through: closed by the policies below it. Re-run: <code className="mono">{data.rerun}</code>
      </Caption>
    </figure>
  );
}

/** Each round, with its mark, in one line. Links down to the round. */
function RoundStrip({ rounds, pending }: { rounds: GauntletRound[]; pending: number }) {
  return (
    <ol className="gt-strip" aria-label="Rounds at a glance">
      {rounds.map((r) => {
        const info = roundInfo(r);
        return (
          <li key={r.n}>
            <a href={`#round-${r.n}`} className={`gt-strip-cell is-${info.tone}`} title={info.label}>
              <span className="mono">{r.n}</span>
              <Mark tone={info.tone} size={13} />
              <span className="sr-only">{info.label}</span>
            </a>
          </li>
        );
      })}
      {Array.from({ length: pending }, (_, i) => (
        <li key={`p${i}`}>
          <span className="gt-strip-cell is-pending">
            <span className="mono">{rounds.length + i + 1}</span>
            <span className="sr-only">Waiting</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function GauntletSection({
  target,
  onAccepted,
  published,
  publishedError,
}: {
  target: Target;
  onAccepted: () => void;
  published: GauntletPublished | null;
  publishedError: string | null;
}) {
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
        <div className="gauntlet-go">
          <PrimaryButton type="button" className="btn-large" disabled={busy || running} onClick={start}>
            {running ? 'Attacking' : busy ? 'Starting' : 'Attack the guardrails'}
          </PrimaryButton>
          <p className="gauntlet-warn">A long job, with real inference and real clones. It runs until the last round ends.</p>
        </div>
      </div>
      {error && (
        <Notice tone="bad" title="The API refused or could not be reached.">
          {error}
        </Notice>
      )}
      <Published data={published} error={publishedError} target={target} />

      <div className="gt-latest">
        <header className="gt-latest-head">
          <Label>Latest run</Label>
          {latest?.id && <code className="mono gt-latest-id">{latest.id}</code>}
          {latest?.status === 'running' && <Stamp tone="live">Running</Stamp>}
        </header>
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
        {(rounds.length > 0 || pending > 0) && <RoundStrip rounds={rounds} pending={pending} />}
        {rounds.length > 0 && (
          <ol className="gt-rounds">
            {rounds.map((r) => (
              <RoundCard key={r.n} round={r} target={target} onAccepted={onAccepted} />
            ))}
            {Array.from({ length: pending }, (_, i) => (
              <li className="gt-round is-pending" key={`p${i}`}>
                <span className="gt-node" aria-hidden="true" />
                <div className="gt-round-head">
                  <span className="mono gt-n">Round {rounds.length + i + 1}</span>
                  <span className="muted">Waiting</span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
