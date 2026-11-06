import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorText, notifyProdChanged } from '../api/client';
import type { AttackCheck, AttackDef, AttackResult, RedTeamRun, WallTwo } from '../api/types';
import { asText, num, when } from '../lib/format';
import { Fold, Hash, Loading, Mark, Notice } from '../ui/bits';

const INSIDE_CHARS = 400;
const INSIDE_LINES = 9;

function preview(output: string): string {
  const lines = output.split('\n');
  const cut = lines.length > INSIDE_LINES ? lines.slice(0, INSIDE_LINES).join('\n') : output;
  return cut.length > INSIDE_CHARS ? cut.slice(0, INSIDE_CHARS) : cut;
}

function checkDetail(d: unknown): string | null {
  if (d === null || d === undefined || d === '') return null;
  if (Array.isArray(d)) return d.map(asText).join(', ');
  if (typeof d === 'object') {
    return Object.entries(d as Record<string, unknown>)
      .map(([k, v]) => `${k} ${asText(v)}`)
      .join(', ');
  }
  return asText(d);
}

function CheckRows({ checks }: { checks: AttackCheck[] }) {
  return (
    <ul className="rt-checks">
      {checks.map((c, i) => {
        const detail = checkDetail(c.detail);
        return (
          <li key={i} className={c.ok ? 'rt-check is-ok' : 'rt-check is-bad'}>
            <Mark tone={c.ok ? 'good' : 'bad'} size={13} />
            <span className="rt-check-word">{c.ok ? 'OK' : 'Failed'}</span>
            <span className="rt-check-text">
              {c.check}
              {detail && <span className="rt-check-detail mono">{detail}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Inside({ output }: { output?: string }) {
  const [open, setOpen] = useState(false);
  if (!output) return <p className="muted rt-inside-empty">The attacker's shell returned no output.</p>;
  const short = preview(output);
  const long = short.length < output.trimEnd().length;
  return (
    <div className="rt-inside">
      <div className="rt-inside-label">What the attacker saw inside</div>
      <pre className="inert">{long && !open ? `${short}\n…` : output}</pre>
      {long && (
        <button type="button" className="textbtn" onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show all ${num(output.length)} characters`}
        </button>
      )}
    </div>
  );
}

// The fork bomb's time limit, from checker/redteam.py. If the runtime errors well before it, this is
// not the expected end, so the raw error is shown with no explanation.
const FORK_BOMB_LIMIT_S = 20;

function killedAtLimit(result?: AttackResult): boolean {
  if (result?.attack !== 'fork_bomb' || !result.ended || result.ended === 'exited') return false;
  return (result.wall_s ?? 0) >= (result.time_cap_s ?? FORK_BOMB_LIMIT_S) - 1;
}

/** Two results read like failures unless you know what they test. */
function AttackNote({ def, result }: { def: AttackDef; result?: AttackResult }) {
  if (def.id === 'injected_row') {
    return <p className="rt-note">The obeying is on purpose. A seeded ticket asks for this DROP, and this plan plays an agent that fell for it. So it is meant to run, inside the clone. The point is to show that even then nothing escapes.</p>;
  }
  if (result?.contained && killedAtLimit(result)) {
    return <p className="rt-note">This is how it should end. The bomb ran until the sandbox hit its {FORK_BOMB_LIMIT_S} s limit and was killed. The runtime reports that as {result.ended}, so there is no exit code or output.</p>;
  }
  return null;
}

function AttackCard({ def, result, running, index }: { def: AttackDef; result?: AttackResult; running: boolean; index: number }) {
  const state = result ? (result.contained ? 'good' : 'bad') : running ? 'live' : 'pending';
  return (
    <li className={`rt-card is-${state}`}>
      <div className="rt-card-head">
        <span className="mono rt-n">{index}</span>
        <h3 className="rt-title">{result?.title ?? def.title ?? def.id}</h3>
        <div className="rt-verdict">
          {result ? (
            <>
              <Mark tone={result.contained ? 'good' : 'bad'} size={15} />
              {result.contained ? 'CONTAINED' : 'NOT CONTAINED'}
            </>
          ) : running ? (
            <>
              <Mark tone="live" size={15} />
              Running
            </>
          ) : (
            <span className="muted">Not run</span>
          )}
        </div>
      </div>
      <p className="rt-expected">
        <span className="label">Expected</span> {result?.expected ?? def.expected}
      </p>
      <AttackNote def={def} result={result} />
      {result && (
        <>
          {result.sandbox_error && (
            <Notice tone="bad" title="Sandbox error">
              <span className="mono">{result.sandbox_error}</span>
            </Notice>
          )}
          <CheckRows checks={result.checks ?? []} />
          <Inside output={result.inside_output} />
          <dl className="rt-facts mono">
            {result.wall_s !== undefined && (
              <div>
                <dt>Ran for</dt>
                <dd>{num(result.wall_s)} s</dd>
              </div>
            )}
            {result.ended && (
              <div>
                <dt>Ended</dt>
                <dd>
                  {killedAtLimit(result) ? `Killed at its limit (${result.ended})` : result.ended}
                  {result.exit_code !== null && result.exit_code !== undefined ? `, exit ${result.exit_code}` : ''}
                </dd>
              </div>
            )}
            {result.host_before && result.host_after && (
              <>
                <div>
                  <dt>Host load</dt>
                  <dd>
                    {num(result.host_before.load_1m)} → {num(result.host_after.load_1m)}
                  </dd>
                </div>
                <div>
                  <dt>Host free memory</dt>
                  <dd>
                    {num(result.host_before.mem_available_mib)} → {num(result.host_after.mem_available_mib)} MiB
                  </dd>
                </div>
              </>
            )}
          </dl>
        </>
      )}
    </li>
  );
}

function SecondWall({ wall, running }: { wall?: WallTwo; running: boolean }) {
  if (!wall) {
    return (
      <section className="rt-wall is-pending" aria-label="Second wall">
        <h2 className="rt-big-title">Second wall</h2>
        <p>The no-NIC wall gets opened on purpose for one sandbox, to test the host firewall alone.</p>
        {running ? <Loading>Runs after the last attack</Loading> : <p className="muted">Not run.</p>}
      </section>
    );
  }
  if (wall.error) {
    return (
      <section className="rt-wall is-bad" aria-label="Second wall">
        <h2 className="rt-big-title">Second wall</h2>
        <Notice tone="bad" title="The second wall test could not run.">
          <span className="mono">{wall.error}</span>
        </Notice>
      </section>
    );
  }
  const ok = wall.contained === true && wall.reached_outside === false;
  const before = wall.firewall_before?.rejected_packets;
  const after = wall.firewall_after?.rejected_packets;
  return (
    <section className={`rt-wall ${ok ? 'is-good' : 'is-bad'}`} aria-label="Second wall">
      <div className="rt-wall-head">
        <h2 className="rt-big-title">Second wall</h2>
        <div className="rt-verdict">
          <Mark tone={ok ? 'good' : 'bad'} size={16} />
          {ok ? 'CONTAINED' : 'NOT CONTAINED'}
        </div>
      </div>
      <p className="rt-wall-what">
        The no-NIC wall was deliberately opened for this one sandbox. {ok ? 'The host firewall alone stopped it.' : 'The host firewall alone did not stop it.'}
      </p>
      <div className="rt-wall-numbers">
        <div>
          <div className="label">Rejected packets at the host firewall</div>
          <div className="rt-wall-count mono">
            {num(before)} <span className="arrow">→</span> {num(after)}
          </div>
          <div className="muted mono">+{num(wall.rejected_delta)} during this test</div>
        </div>
        <ul className="rt-checks">
          <li className={wall.reached_outside === false ? 'rt-check is-ok' : 'rt-check is-bad'}>
            <Mark tone={wall.reached_outside === false ? 'good' : 'bad'} size={13} />
            <span className="rt-check-word">{wall.reached_outside === false ? 'OK' : 'Failed'}</span>
            <span className="rt-check-text">{wall.reached_outside === false ? 'Nothing reached the outside' : 'Something reached the outside'}</span>
          </li>
          <li className={wall.rootfs_gone ? 'rt-check is-ok' : 'rt-check is-bad'}>
            <Mark tone={wall.rootfs_gone ? 'good' : 'bad'} size={13} />
            <span className="rt-check-word">{wall.rootfs_gone ? 'OK' : 'Failed'}</span>
            <span className="rt-check-text">{wall.rootfs_gone ? 'Clone disk deleted afterwards' : 'Clone disk still on the host'}</span>
          </li>
        </ul>
      </div>
      {wall.output && (
        <div className="rt-inside">
          <div className="rt-inside-label">What the attacker saw inside</div>
          <pre className="inert">{wall.output}</pre>
        </div>
      )}
    </section>
  );
}

function ProdCard({ run }: { run: RedTeamRun }) {
  const running = run.status === 'running';
  if (run.status === 'error' && run.prod_unchanged === undefined) return null;
  if (run.prod_unchanged === undefined) {
    return (
      <section className="rt-prod is-pending" aria-label="Prod checksum">
        <h2 className="rt-prod-word">Prod checksum</h2>
        <dl className="rt-prod-hashes">
          <div>
            <dt>Before</dt>
            <dd className="mono">{run.prod_before ?? 'measuring'}</dd>
          </div>
          <div>
            <dt>After</dt>
            <dd className="mono">{running ? 'measured when the last attack ends' : 'not measured'}</dd>
          </div>
        </dl>
      </section>
    );
  }
  const untouched = run.prod_unchanged === true && run.prod_before === run.prod_after;
  return (
    <section className={`rt-prod ${untouched ? 'is-good' : 'is-bad'}`} aria-label="Prod checksum">
      <div className="rt-prod-word">
        <Mark tone={untouched ? 'good' : 'bad'} size={44} />
        <h2>{untouched ? 'Prod untouched' : 'Prod changed'}</h2>
      </div>
      <p className="rt-prod-why">
        {untouched ? 'The checksum of prod is identical before and after every attack.' : 'The checksum of prod differs. Something changed it during this run.'} Measured from the control plane, outside the sandbox.
      </p>
      <dl className="rt-prod-hashes">
        <div>
          <dt>Before</dt>
          <dd className="mono">{run.prod_before ?? 'not measured'}</dd>
        </div>
        <div>
          <dt>After</dt>
          <dd className="mono">{run.prod_after ?? 'not measured'}</dd>
        </div>
      </dl>
    </section>
  );
}

export function RedTeamPage() {
  const [attacks, setAttacks] = useState<AttackDef[] | null>(null);
  const [latest, setLatest] = useState<RedTeamRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const list = await api.redteamList(1);
    setLatest(list[0] ?? null);
    return list[0] ?? null;
  }, []);

  useEffect(() => {
    let stopped = false;
    Promise.all([api.redteamAttacks().catch((e) => {
      if (!stopped) setError(errorText(e));
      return null;
    }), refresh().catch((e) => {
      if (!stopped) setError(errorText(e));
      return null;
    })]).then(([defs]) => {
      if (stopped) return;
      setAttacks(defs);
      setLoaded(true);
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
        if (next?.status !== 'running') {
          notifyProdChanged();
          return;
        }
      } catch (e) {
        if (!stopped) setError(errorText(e));
      }
      if (!stopped) timer = window.setTimeout(tick, 1500);
    };
    timer = window.setTimeout(tick, 1500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [running, refresh]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await api.redteamStart();
      setLatest(run);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const results = latest?.attacks ?? [];
  // The fixed list decides the order. If the list failed to load, show what the run itself returned.
  const defs: AttackDef[] = attacks?.length ? attacks : results.map((r) => ({ id: r.attack, title: r.title, expected: r.expected }));
  const extra = results.filter((r) => !defs.some((d) => d.id === r.attack));
  const allDefs = [...defs, ...extra.map((r) => ({ id: r.attack, title: r.title, expected: r.expected }))];
  const done = results.length;
  const contained = results.filter((r) => r.contained).length;
  const total = latest?.total ?? latest?.expected ?? allDefs.length;
  const firstPending = allDefs.find((d) => !results.some((r) => r.attack === d.id))?.id;

  return (
    <div className="page redteam">
      <header className="rt-head">
        <div className="rt-head-text">
          <h1 className="page-title">Red team</h1>
          <p className="page-lead">Each attack runs for real, in its own microVM on a clone of prod. Host-side checks and an outside checksum decide what happened, not the sandbox.</p>
        </div>
        <button type="button" className="btn btn-primary btn-huge" disabled={busy || running} onClick={start}>
          {running ? 'Running' : busy ? 'Starting' : 'Run the red team'}
        </button>
      </header>

      {error && <Notice tone="bad" title="The API refused or could not be reached.">{error}</Notice>}
      {!loaded && <Loading />}

      {latest && (
        <div className="rt-summary">
          <span className="mono rt-score">
            {running ? `${num(done)} of ${num(total)} run, ${num(contained)} contained` : `${num(contained)} of ${num(total)} contained`}
          </span>
          <ol className="rt-ticks" aria-hidden="true">
            {allDefs.map((d) => {
              const r = results.find((x) => x.attack === d.id);
              const c = r ? (r.contained ? 'is-good' : 'is-bad') : running && d.id === firstPending ? 'is-live' : '';
              return <li key={d.id} className={c} />;
            })}
          </ol>
          <span className="muted rt-meta">
            {running ? 'Running now.' : latest.status === 'error' ? 'Stopped with an error.' : 'Latest run.'} <span className="mono">{when(latest.created_at)}</span>, by <span className="mono">{latest.requester ?? 'unknown'}</span>
          </span>
        </div>
      )}
      {loaded && !latest && <p className="notmeasured">No red team run yet. Press the button to run one.</p>}
      {latest?.status === 'error' && (
        <Notice tone="bad" title="The red team run stopped with an error.">
          <span className="mono">{latest.error ?? 'No detail given.'}</span>
        </Notice>
      )}

      {allDefs.length > 0 && (
        <ol className="rt-cards">
          {allDefs.map((d, i) => (
            <AttackCard key={d.id} def={d} index={i + 1} result={results.find((r) => r.attack === d.id)} running={running && d.id === firstPending} />
          ))}
        </ol>
      )}

      {latest && (
        <>
          <SecondWall wall={latest.wall_two} running={running} />
          <ProdCard run={latest} />
          <Fold summary="Run details">
            <dl className="kvs">
              <div className="kv">
                <dt>Red team run</dt>
                <dd>
                  <Hash value={latest.id} chars={20} />
                </dd>
              </div>
              {latest.prod_during && (
                <div className="kv">
                  <dt>Prod checksum after the last attack finished</dt>
                  <dd className="mono rt-during">{latest.prod_during}</dd>
                </div>
              )}
            </dl>
          </Fold>
        </>
      )}
    </div>
  );
}
