import './_styles';
import '../styles/pg-redteam-guardrails.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ApiError, api, errorText, notifyProdChanged } from '../api/client';
import type { AttackCheck, AttackDef, AttackResult, Phases, RedTeamRun, WallTwo } from '../api/types';
import { asText, isNum, ms, num, short, when } from '../lib/format';
import { useReducedMotion } from '../lib/media';
import { CopyButton, Fold, Hash, Loading, Mark, Notice } from '../ui/bits';
import { Caption, sourceLine } from '../ui/Figure';
import { Frame } from '../ui/Frame';
import { PrimaryButton } from '../ui/Halftone';
import { Label } from '../ui/Label';
import { Measured } from '../ui/Measured';
import { Stamp } from '../ui/Stamp';

const INSIDE_CHARS = 400;
const INSIDE_LINES = 9;
/** How many lines fit on a chamber's screen. Older ones scroll off the top, like a terminal. */
const SCREEN_LINES = 8;
const BURN_LINES = 4;

// The CRT-off: down to a line over the sandbox's measured destroy time, then this long to go out.
const CRT_X_MS = 120;
// A live result prints at its measured speed unless that would hold the screen longer than this.
const LIVE_PRINT_MS = 1200;
// Screens never start dying closer together than this, so they go dark one after another.
const LIVE_STAGGER_MS = 360;
const ROW_STAGGER_MS = 24;
const POLL_MS = 1000;

/** The API returns measured phase lengths for each attack. */
type Attack = AttackResult & { phases?: Phases };

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

function outputLines(output?: string): string[] {
  return (output ?? '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

/** What the host says is left of the sandbox, in the three checks that decide it. Null if the result doesn't carry them. */
function teardown(r: AttackResult): { gone: boolean; words: { text: string; ok: boolean }[] } | null {
  const find = (re: RegExp) => r.checks?.find((c) => re.test(c.check ?? ''));
  const listed = find(/^Sandbox removed/);
  const disk = find(/^Clone disk deleted/);
  const procs = find(/^No leftover processes/);
  if (!listed && !disk && !procs) return null;
  const words = [
    listed && { text: listed.ok ? 'not listed' : 'listing check failed', ok: listed.ok === true },
    disk && { text: disk.ok ? 'disk gone' : 'disk check failed', ok: disk.ok === true },
    procs && { text: procs.ok ? 'no processes left' : 'process check failed', ok: procs.ok === true },
  ].filter(Boolean) as { text: string; ok: boolean }[];
  return { gone: !!listed?.ok && !!disk?.ok && !!procs?.ok, words };
}

interface LogLine {
  at: number;
  label: string;
  value?: string;
  output?: boolean;
}

/** The console for one attack, from what the API measured. Output lines are spread across the execute phase: the phase
 *  length is measured, but when each line appeared inside it is not. */
function consoleLog(r: Attack): { lines: LogLine[]; runMs: number; destroyMs: number; bootMs: number } {
  const lines: LogLine[] = [{ at: 0, label: `$ ${r.attack}` }];
  const out = outputLines(r.inside_output);
  const p = r.phases;
  if (!p) {
    out.forEach((label, i) => lines.push({ at: Math.min(i + 1, 12) * ROW_STAGGER_MS, label, output: true }));
    return { lines, runMs: (Math.min(out.length, 12) + 1) * ROW_STAGGER_MS, destroyMs: 0, bootMs: 0 };
  }
  let t = 0;
  const phase = (label: string, value?: number) => {
    if (!isNum(value)) return;
    t += value;
    lines.push({ at: t, label, value: ms(value) });
  };
  phase('boot', p.clone_boot_ms);
  const bootMs = t;
  phase('first exec', p.first_exec_ms);
  phase('probes', p.probe_ms);
  const start = t;
  const length = p.execute_ms ?? 0;
  out.forEach((label, i) => lines.push({ at: start + ((i + 1) / (out.length + 1)) * length, label, output: true }));
  phase('execute', p.execute_ms);
  phase('secret scan', p.secret_scan_ms);
  if (isNum(p.destroy_ms)) lines.push({ at: t, label: 'destroy', value: ms(p.destroy_ms) });
  return { lines, runMs: t, destroyMs: p.destroy_ms ?? 0, bootMs };
}

/** When a chamber's screen should start, and how fast. `replay` runs at measured speed from a dark start. */
interface Cue {
  gen: number;
  at: number;
  scale: number;
  replay: boolean;
}

type Stage = 'idle' | 'booting' | 'printing' | 'dying' | 'dead' | 'landed';

/** Plays one screen from a cue. Nothing measured waits on this: the facts under the screen are already there. */
function useScreen(result: Attack | undefined, cue: Cue | undefined) {
  const [play, setPlay] = useState<{ stage: Stage; shown: number; scanning: boolean } | null>(null);
  useLayoutEffect(() => {
    if (!cue || !result) {
      setPlay(null);
      return;
    }
    const log = consoleLog(result);
    const dies = teardown(result)?.gone === true;
    let frame = 0;
    const set = (stage: Stage, shown: number, scanning: boolean) => {
      setPlay((prev) => (prev && prev.stage === stage && prev.shown === shown && prev.scanning === scanning ? prev : { stage, shown, scanning }));
    };
    const tick = () => {
      const t = performance.now() - cue.at;
      if (t < 0) {
        set(cue.replay ? 'idle' : 'booting', 0, !cue.replay);
        frame = requestAnimationFrame(tick);
        return;
      }
      const printEnd = log.runMs * cue.scale;
      if (t < printEnd) {
        set('printing', log.lines.filter((l) => l.at * cue.scale <= t).length, t < log.bootMs * cue.scale);
        frame = requestAnimationFrame(tick);
        return;
      }
      if (dies && t < printEnd + log.destroyMs + CRT_X_MS) {
        set('dying', log.lines.length, false);
        frame = requestAnimationFrame(tick);
        return;
      }
      set('landed', log.lines.length, false);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [cue, result]);
  return play;
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

function DotWords({ first, second, className = '' }: { first: string; second: string; className?: string }) {
  return (
    <div className={`t-dot dot-words ${className}`}>
      <span className="sr-only">
        {first}: {second}
      </span>
      <span aria-hidden="true">{first}</span>
      <i className="dot-colon" aria-hidden="true" />
      <span aria-hidden="true">{second}</span>
    </div>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The chamber's screen. It stays dark in both themes, because a screen is dark on paper too. */
function Screen({ def, index, result, stage, shown, scanning }: { def: AttackDef; index: number; result?: Attack; stage: Stage; shown: number; scanning: boolean }) {
  const log = result ? consoleLog(result) : null;
  const tail = outputLines(result?.inside_output).slice(-BURN_LINES);
  const down = result ? teardown(result) : null;
  const noNic = result?.checks?.find((c) => /^Guest had no network device/.test(c.check ?? ''));
  const style = { '--crt-y': `${Math.max(1, log?.destroyMs ?? 0)}ms`, '--crt-x': `${CRT_X_MS}ms` } as CSSProperties;
  const lines = log ? log.lines.slice(0, shown).slice(-SCREEN_LINES) : [];
  return (
    <div className="rt-screen" style={style}>
      <div className="rt-screen-head">
        <span className="t-label rt-screen-n" aria-hidden="true">
          [ {pad(index)} ]
        </span>
        <span className="rt-screen-id">{def.id}</span>
        {noNic && <span className={noNic.ok ? 'rt-screen-nic' : 'rt-screen-nic is-bad'}>{noNic.ok ? 'no network card' : 'network card check failed'}</span>}
      </div>
      <div className="rt-screen-body">
        {stage === 'booting' && (
          <div className="rt-live" aria-hidden="true">
            <ol className="rt-log">
              <li className="rt-log-line">$ {def.id}</li>
            </ol>
          </div>
        )}
        {(stage === 'printing' || stage === 'dying') && (
          <div className="rt-live" aria-hidden="true">
            <ol className="rt-log">
              {lines.map((l, i) => (
                <li key={`${l.label}-${l.at}-${i}`} className={l.output ? 'rt-log-line is-output' : 'rt-log-line'}>
                  <span>{l.label}</span>
                  {l.value && <span className="rt-log-value">{l.value}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
        {(stage === 'booting' || scanning) && <i className="rt-scan" aria-hidden="true" />}
        {(stage === 'dead' || stage === 'landed') && result && (
          <div className="rt-dead">
            <pre className="rt-burn" aria-hidden="true">
              {tail.length ? tail.join('\n') : 'no output'}
            </pre>
            <div className="rt-dead-foot">
              {down?.gone ? <div className="t-dot rt-gone">Gone</div> : down ? <div className="t-dot rt-gone is-bad">Check</div> : null}
              {down ? (
                <ul className="rt-gone-lines">
                  {down.words.map((w) => (
                    <li key={w.text} className={w.ok ? undefined : 'is-bad'}>
                      {w.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rt-gone-lines">Teardown not measured</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Real bars on one time scale across the run: what each attack cost, phase by phase. */
function TimeBar({ result, longest }: { result: Attack; longest: number }) {
  const wall = result.wall_s;
  if (!isNum(wall) || longest <= 0) return null;
  const p = result.phases;
  const parts: [string, number | undefined][] = p
    ? [
        ['boot', p.clone_boot_ms],
        ['first exec', p.first_exec_ms],
        ['probes', p.probe_ms],
        ['execute', p.execute_ms],
        ['secret scan', p.secret_scan_ms],
        ['destroy', p.destroy_ms],
      ]
    : [];
  const known = parts.filter(([, v]) => isNum(v)) as [string, number][];
  const sum = known.reduce((a, [, v]) => a + v, 0);
  const said = known.map(([k, v]) => `${k} ${ms(v)}`).join(', ');
  return (
    <div className="rt-bar" role="img" aria-label={`Ran for ${num(wall)} s. ${said}`} title={said || undefined}>
      <div className="rt-bar-fill" style={{ width: `${Math.max(1, (wall / longest) * 100)}%` }}>
        {known.length > 0 ? known.map(([k, v]) => <i key={k} className={k === 'execute' ? 'is-execute' : undefined} style={{ flexGrow: Math.max(v, sum / 200) }} />) : <i className="is-execute" style={{ flexGrow: 1 }} />}
      </div>
    </div>
  );
}

function Chamber({
  def,
  result,
  running,
  runLive,
  index,
  longest,
  cue,
}: {
  def: AttackDef;
  result?: Attack;
  running: boolean;
  runLive: boolean;
  index: number;
  longest: number;
  cue?: Cue;
}) {
  const play = useScreen(result, cue);
  const stage: Stage = play?.stage ?? (result ? 'dead' : running ? 'booting' : 'idle');
  const landed = stage === 'dead' || stage === 'landed';
  const state = result ? (result.contained ? 'good' : 'bad') : running ? 'live' : 'pending';
  const passed = result?.checks?.filter((c) => c.ok).length ?? 0;
  const total = result?.checks?.length ?? 0;
  const failed = total - passed;
  // A replay starts dark and without colour, and the colour comes back with the stamp. The word stays readable throughout.
  const quiet = !!cue?.replay && !landed;

  return (
    <li className={`rt-chamber is-${state} stage-${stage}`}>
      <Screen def={def} index={index} result={result} stage={stage} shown={play?.shown ?? 0} scanning={play?.scanning ?? false} />
      <div className="rt-chamber-body">
        <div className="rt-chamber-verdict">
          {result ? (
            <Stamp tone={quiet ? 'neutral' : result.contained ? 'good' : 'bad'}>{result.contained ? 'Contained' : 'Not contained'}</Stamp>
          ) : running ? (
            <Stamp tone="live">Running</Stamp>
          ) : (
            <span className="rt-chamber-waiting">{runLive ? 'Waiting' : 'Not run'}</span>
          )}
          {result && isNum(result.wall_s) && <span className="rt-chamber-ran mono">{num(result.wall_s)} s</span>}
        </div>
        <h3 className="rt-title">{result?.title ?? def.title ?? def.id}</h3>
        <p className="rt-expected">
          <span className="rt-expected-word">Expected</span> {result?.expected ?? def.expected}
        </p>
        <AttackNote def={def} result={result} />
        {!result && (
          <>
            <div className="rt-bar" aria-hidden="true" />
            <div className="rt-folds rt-folds-empty" aria-hidden="true">
              <div className="rt-folds-row">Checks not run</div>
              <div className="rt-folds-row">No output yet</div>
            </div>
          </>
        )}
        {result && (
          <>
            {result.sandbox_error && (
              <Notice tone="bad" title="Sandbox error">
                <span className="mono">{result.sandbox_error}</span>
              </Notice>
            )}
            <TimeBar result={result} longest={longest} />
            <div className="rt-folds">
              <Fold
                open={failed > 0}
                summary={
                  <span className="rt-fold-sum">
                    <Mark tone={failed > 0 ? 'bad' : 'good'} size={13} />
                    {num(passed)} of {num(total)} checks
                  </span>
                }
              >
                <CheckRows checks={result.checks ?? []} />
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
              </Fold>
              <Fold summary="What the attacker saw inside">
                <Inside output={result.inside_output} />
              </Fold>
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/** A firewall reading, or why there isn't one. The API sends that reason alongside `available: false`. */
function firewallCount(f?: WallTwo['firewall_before'] & { reason?: string }): { n?: number; reason?: string } {
  if (!f) return {};
  if (f.available === false) return { reason: f.reason };
  return { n: f.rejected_packets };
}

function wallTone(line: string): string | undefined {
  // "REACHED OUTSIDE" is the sandbox's own report. A curl that got any HTTP status got out as well.
  if (/REACHED OUTSIDE/.test(line) || /HTTP (?!000)\d{3}\s*$/.test(line)) return 'is-bad';
  return undefined;
}

function SecondWall({ wall, running, attacksDone }: { wall?: WallTwo; running: boolean; attacksDone: boolean }) {
  const head = (extra?: ReactNode) => (
    <div className="rt-wall-head">
      <h2 className="rt-wall-title" id="rt-wall-title">
        <Label>Second wall</Label>
      </h2>
      {extra}
    </div>
  );
  if (!wall) {
    return (
      <section className="rt-wall is-pending" aria-labelledby="rt-wall-title">
        {head()}
        <p className="rt-wall-what">The no-NIC wall gets opened on purpose for one sandbox, to test the host firewall alone.</p>
        {running ? <Loading>{attacksDone ? 'Running now' : 'Runs after the last attack'}</Loading> : <p className="muted">Not run.</p>}
      </section>
    );
  }
  if (wall.error) {
    return (
      <section className="rt-wall is-bad" aria-labelledby="rt-wall-title">
        {head()}
        <Notice tone="bad" title="The second wall test could not run.">
          <span className="mono">{wall.error}</span>
        </Notice>
      </section>
    );
  }
  const ok = wall.contained === true && wall.reached_outside === false;
  const before = firewallCount(wall.firewall_before);
  const after = firewallCount(wall.firewall_after);
  const counted = isNum(before.n) && isNum(after.n);
  return (
    <section className={`rt-wall ${ok ? 'is-good' : 'is-bad'}`} aria-labelledby="rt-wall-title">
      <div className="rt-wall-main">
        {head(<Stamp tone={ok ? 'good' : 'bad'}>{ok ? 'Contained' : 'Not contained'}</Stamp>)}
        <DotWords first="Wall" second={ok ? 'Held' : 'Failed'} className="rt-wall-word" />
        <p className="rt-wall-what">
          The no-NIC wall was deliberately opened for this one sandbox. {ok ? 'The host firewall alone stopped it.' : 'The host firewall alone did not stop it.'}
        </p>
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
        <div className="rt-wall-counter">
          <div className="rt-wall-counter-label">Rejected packets at the host firewall</div>
          {counted ? (
            <>
              <div className="rt-wall-count t-num-l">
                <Measured value={before.n} format={num} /> <span className="arrow">→</span> <Measured value={after.n} format={num} />
              </div>
              <div className="muted mono">+{num(wall.rejected_delta)} during this test</div>
            </>
          ) : (
            <>
              <div className="rt-wall-count-empty">Not measured</div>
              {(after.reason ?? before.reason) && <div className="muted mono rt-wall-reason">{after.reason ?? before.reason}</div>}
            </>
          )}
        </div>
      </div>
      {wall.output && (
        <div className="rt-wall-screen">
          <div className="rt-screen-head">
            <span className="t-label rt-screen-n">What the attacker saw inside</span>
          </div>
          <pre className="rt-wall-output">
            {outputLines(wall.output).map((l, i) => (
              <span key={i} className={wallTone(l)}>
                {l}
                {'\n'}
              </span>
            ))}
          </pre>
        </div>
      )}
    </section>
  );
}

function HashChars({ value, base }: { value: string; base?: string }) {
  if (!base || base === value) return <code>{value}</code>;
  // A hash that differs shows where: colour arrives with the evidence.
  return (
    <code>
      {value.split('').map((c, i) => (
        <span key={i} className={c === base[i] ? undefined : 'rt-hash-diff'}>
          {c}
        </span>
      ))}
    </code>
  );
}

function HashRow({ name, value, base, waiting, id }: { name: string; value?: string; base?: string; waiting: string; id?: string }) {
  return (
    <div className="rt-hash-row" id={id}>
      <dt>{name}</dt>
      <dd>
        {value ? (
          <>
            <span className="rt-hash-text" title={value}>
              <HashChars value={value} base={base} />
            </span>
            <span className="rt-hash-short mono">{short(value, 12)}</span>
            <CopyButton value={value} />
          </>
        ) : (
          <span className="rt-hash-waiting">
            <span className="rt-wait-long">{waiting}</span>
            <span className="rt-wait-short" aria-hidden="true">
              not yet
            </span>
          </span>
        )}
      </dd>
    </div>
  );
}

/** The cold side of the page. It has no animation at all. Values change only when the API measures a new one. */
function ProdStrip({ run }: { run: RedTeamRun | null }) {
  const running = run?.status === 'running';
  const measured = run?.prod_unchanged !== undefined;
  const movedDuring = !!run?.prod_before && !!run?.prod_during && run.prod_before !== run.prod_during;
  const untouched = measured && run?.prod_unchanged === true && run?.prod_before === run?.prod_after && !movedDuring;
  const state = !measured && !movedDuring ? 'pending' : untouched ? 'good' : 'bad';
  return (
    <section className={`rt-prod is-${state}`} aria-labelledby="rt-prod-title">
      <i className="frame-tick tl" aria-hidden="true" />
      <i className="frame-tick tr" aria-hidden="true" />
      <div className="rt-prod-side">
        <div className="rt-prod-head">
          <h2 className="rt-prod-title" id="rt-prod-title">
            <Label>Prod</Label>
          </h2>
          {run && <span className="rt-prod-source">measured outside the sandbox, run {run.id}</span>}
        </div>
        {state === 'pending' ? (
          <p className="rt-prod-state">{run ? (running ? 'Measured when the last attack ends' : 'Not measured') : 'Not measured yet'}</p>
        ) : (
          <div className="rt-prod-verdict">
            <DotWords first="Prod" second={state === 'good' ? 'Same' : 'Moved'} className="rt-prod-word" />
            <p className="rt-prod-state">
              <Mark tone={state === 'good' ? 'good' : 'bad'} size={14} />
              {state === 'good' ? 'Prod untouched' : 'Prod changed'}
            </p>
          </div>
        )}
      </div>
      <dl className="rt-hashes">
        <HashRow name="Before" value={run?.prod_before} waiting={run ? 'measuring' : 'not measured'} />
        <HashRow name="During" value={run?.prod_during} base={run?.prod_before} waiting={running ? 'measured after the first attack' : 'not measured'} />
        <HashRow name="After" value={run?.prod_after} base={run?.prod_before} waiting={running ? 'measured when the last attack ends' : 'not measured'} />
      </dl>
    </section>
  );
}

/** What the strip can't hold while it is pinned: the words that say what the hashes mean. */
function ProdNotes({ run }: { run: RedTeamRun }) {
  if (run.status === 'error' && run.prod_unchanged === undefined) return null;
  if (run.prod_unchanged === undefined) return null;
  const movedDuring = !!run.prod_before && !!run.prod_during && run.prod_before !== run.prod_during;
  const untouched = run.prod_unchanged === true && run.prod_before === run.prod_after && !movedDuring;
  return (
    <div className="rt-prod-notes">
      <p className="rt-prod-why">
        <Mark tone={untouched ? 'good' : 'bad'} size={14} />
        <span>
          {untouched ? 'The checksum of prod is identical before and after every attack.' : 'The checksum of prod differs. Something changed it during this run.'} Measured by Shadow Run's own server, outside the sandbox. It is read again after each attack, and During is the latest of those.
        </span>
      </p>
      {run.golden_unchanged !== undefined ? (
        <p className="rt-prod-why">
          <Mark tone={run.golden_unchanged ? 'good' : 'bad'} size={14} />
          <span>{run.golden_unchanged ? 'A new clone made after all the attacks matches one made before them, so nothing reached the master copy either.' : 'A new clone made after the attacks does not match one made before them.'}</span>
        </p>
      ) : (
        <p className="rt-prod-why">
          <Mark tone="neutral" size={14} />
          <span>This run did not compare a new clone with the master copy.</span>
        </p>
      )}
    </div>
  );
}

export function RedTeamPage() {
  const [attacks, setAttacks] = useState<AttackDef[] | null>(null);
  const [latest, setLatest] = useState<RedTeamRun | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cues, setCues] = useState<Record<string, Cue>>({});
  const [replaying, setReplaying] = useState(false);
  const reduced = useReducedMotion();
  const watch = useRef<{ run: string | null; seen: Set<string>; last: number; gen: number }>({ run: null, seen: new Set(), last: 0, gen: 0 });
  const replayTimer = useRef(0);

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
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [running, refresh]);

  // A result that arrives while we watch gets its screen played, once. One that was already there is simply shown.
  useLayoutEffect(() => {
    if (!latest) return;
    const w = watch.current;
    const got = (latest.attacks ?? []) as Attack[];
    if (w.run !== latest.id) {
      w.run = latest.id;
      w.seen = new Set(got.map((r) => r.attack));
      w.last = 0;
      setCues({});
      return;
    }
    const fresh = got.filter((r) => !w.seen.has(r.attack));
    if (!fresh.length) return;
    fresh.forEach((r) => w.seen.add(r.attack));
    if (reduced) return;
    const now = performance.now();
    const next: Record<string, Cue> = {};
    for (const r of fresh) {
      const at = Math.max(now, w.last + LIVE_STAGGER_MS);
      w.last = at;
      const { runMs } = consoleLog(r);
      next[r.attack] = { gen: ++w.gen, at, scale: runMs > LIVE_PRINT_MS ? LIVE_PRINT_MS / runMs : 1, replay: false };
    }
    setCues((prev) => ({ ...prev, ...next }));
  }, [latest, reduced]);

  useEffect(() => () => window.clearTimeout(replayTimer.current), []);

  const results = (latest?.attacks ?? []) as Attack[];

  const stopReplay = () => {
    window.clearTimeout(replayTimer.current);
    setReplaying(false);
    setCues({});
  };

  const replay = () => {
    const w = watch.current;
    let at = performance.now() + 300;
    const next: Record<string, Cue> = {};
    for (const r of results) {
      const log = consoleLog(r);
      next[r.attack] = { gen: ++w.gen, at, scale: 1, replay: true };
      at += log.runMs + log.destroyMs + CRT_X_MS + 200;
    }
    setCues(next);
    setReplaying(true);
    window.clearTimeout(replayTimer.current);
    replayTimer.current = window.setTimeout(() => setReplaying(false), at - performance.now());
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    stopReplay();
    try {
      const run = await api.redteamStart();
      setLatest(run);
      window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' });
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  // The fixed list decides the order. If the list failed to load, show what the run itself returned.
  const defs: AttackDef[] = attacks?.length ? attacks : results.map((r) => ({ id: r.attack, title: r.title, expected: r.expected }));
  const extra = results.filter((r) => !defs.some((d) => d.id === r.attack));
  const allDefs = [...defs, ...extra.map((r) => ({ id: r.attack, title: r.title, expected: r.expected }))];
  const done = results.length;
  const contained = results.filter((r) => r.contained).length;
  const total = latest?.total ?? latest?.expected ?? allDefs.length;
  const firstPending = allDefs.find((d) => !results.some((r) => r.attack === d.id))?.id;
  const longest = Math.max(0, ...results.map((r) => r.wall_s ?? 0));
  const canReplay = !reduced && !running && results.some((r) => r.phases);
  // Any attack that was not contained is shown as that at once. All clear waits for the whole run.
  const anyEscaped = results.some((r) => !r.contained);
  const scoreTone = anyEscaped ? ' is-bad' : !running && latest?.status !== 'error' && total > 0 && contained === total ? ' is-good' : '';
  const wall = latest?.wall_two;
  const wallOk = wall && !wall.error && wall.contained === true && wall.reached_outside === false;

  return (
    <div className="page redteam">
      <header className="rt-head">
        <div className="rt-head-text">
          <Label>Attacks on a clone</Label>
          <h1 className="page-title">Red team</h1>
          <p className="page-lead">Each attack runs for real, in its own microVM on a clone of prod. Host-side checks and an outside checksum decide what happened, not the sandbox.</p>
        </div>
        <div className="rt-head-side">
          {latest ? (
            <div className="rt-result">
              <p className={`rt-score t-num-l${scoreTone}`}>
                <span className="sr-only">
                  {running ? `${num(done)} of ${num(total)} run, ${num(contained)} contained` : `${num(contained)} of ${num(total)} contained`}
                </span>
                <span aria-hidden="true">
                  <Measured value={running ? done : contained} format={num} /> of <Measured value={total} format={num} />
                </span>
              </p>
              <div className="rt-result-right">
                <p className="rt-score-word" aria-hidden="true">
                  {running ? (
                    <>
                      run, <Measured value={contained} format={num} /> contained
                    </>
                  ) : (
                    'contained'
                  )}
                </p>
                <ol className="rt-ticks" aria-hidden="true">
                  {allDefs.map((d) => {
                    const r = results.find((x) => x.attack === d.id);
                    const c = r ? (r.contained ? 'is-good' : 'is-bad') : running && d.id === firstPending ? 'is-live' : '';
                    return <li key={d.id} className={c} />;
                  })}
                </ol>
              </div>
            </div>
          ) : (
            loaded && <p className="rt-score-empty">Not measured yet</p>
          )}
          <div className="rt-actions">
            <PrimaryButton type="button" className="btn-large" disabled={busy || running} onClick={start}>
              {running ? 'Running' : busy ? 'Starting' : 'Run the red team'}
            </PrimaryButton>
            {!reduced && (
              <button type="button" className="btn btn-large rt-replay" disabled={!canReplay} onClick={replaying ? stopReplay : replay}>
                {replaying ? 'Skip to the end' : 'Replay'}
              </button>
            )}
          </div>
          <p className="rt-actions-note">Run uses real microVMs and goes until the last attack ends.{!reduced && ' Replay runs nothing new.'}</p>
        </div>
      </header>

      {error && <Notice tone="bad" title="The API refused or could not be reached.">{error}</Notice>}
      {!loaded && <Loading />}

      {latest && (
        <div className="rt-summary">
          <span className="rt-meta">
            {running ? 'Running now.' : latest.status === 'error' ? 'Stopped with an error.' : 'Latest run.'} <span className="mono">{when(latest.created_at)}</span>, by <span className="mono">{latest.requester ?? 'unknown'}</span>
          </span>
          {wall && (
            <a className={`rt-summary-wall ${wallOk ? 'is-good' : 'is-bad'}`} href="#rt-wall">
              <Mark tone={wallOk ? 'good' : 'bad'} size={13} />
              Second wall: {wall.error ? 'could not run' : wallOk ? 'held' : 'failed'}
            </a>
          )}
        </div>
      )}
      {loaded && !latest && <p className="notmeasured">No red team run yet. Press the button to run one.</p>}
      {latest?.status === 'error' && (
        <Notice tone="bad" title="The red team run stopped with an error.">
          <span className="mono">{latest.error ?? 'No detail given.'}</span>
        </Notice>
      )}

      <div className="rt-stage">
        {allDefs.length > 0 && (
          <figure className="rt-figure">
            <h2 className="sr-only">The attacks</h2>
            <Frame className="rt-frame">
              <ol className="rt-grid">
                {allDefs.map((d, i) => (
                  <Chamber key={d.id} def={d} index={i + 1} result={results.find((r) => r.attack === d.id)} running={running && d.id === firstPending} runLive={running} longest={longest} cue={cues[d.id]} />
                ))}
              </ol>
            </Frame>
            {latest && results.length > 0 && (
              <Caption>
                {sourceLine({ n: 1, run: latest.id, measured: latest.created_at, scale: `bars share one time scale, longest ${num(longest)} s` })}. Phase lengths are measured. Order inside a phase isn't.
              </Caption>
            )}
          </figure>
        )}
        {latest && (
          <div id="rt-wall">
            <SecondWall wall={wall} running={running} attacksDone={done >= total} />
          </div>
        )}
        <ProdStrip run={latest} />
      </div>

      {latest && (
        <>
          <ProdNotes run={latest} />
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
      <p className="sr-only" role="status">
        {running ? `${num(done)} of ${num(total)} attacks run, ${num(contained)} contained.` : latest ? `${num(contained)} of ${num(total)} contained.` : ''}
      </p>
    </div>
  );
}
