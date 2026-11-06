import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PublicHero } from '../api/types';
import { num, short } from '../lib/format';
import { cssVar, onThemeChange } from '../lib/media';
import type { Tone } from '../lib/status';
import { CopyButton, Mark } from './bits';
import { asInputs, layoutDots, type DotLayout, type TableInput } from './dotfield';
import { Frame } from './Frame';
import { Label } from './Label';
import { Measured } from './Measured';
import { buildScript, seededOrder, teardownWords, type Script } from './rehearsal';

const DPR_CAP = 2;
const dprNow = () => Math.min(window.devicePixelRatio || 1, DPR_CAP);

export type RoomsStatus = 'waiting' | 'running' | 'done';

export interface RehearsalControl {
  script: Script | null;
  /** The latest moment that has landed, in replay milliseconds. Everything in the DOM is a function of this. */
  cue: number;
  status: RoomsStatus;
  speed: number;
  /** Which phase the reduced-motion stepper is on, or -1 when showing the end state. */
  stop: number;
  replay: () => void;
  setSpeed: (s: number) => void;
  finish: () => void;
  stepNext: () => void;
  /** The clock, for code that paints every frame. */
  clock: React.MutableRefObject<number>;
  onFrame: React.MutableRefObject<Set<(t: number) => void>>;
}

/** What prod's pane says at the end, when that isn't simply "the rehearsal left the hash alone". */
export interface ProdView {
  word: string;
  tone: Tone;
  verdict: string;
  hashes: { label: string; value?: string | null }[];
  note?: string | null;
  /** Shown until the measurement lands. */
  waiting?: string;
  /** A line for the cold ledger, such as when the hash was checked. */
  checkedAt?: string | null;
  /** Rises when a real apply commits or rolls back. The single time prod is allowed to move. */
  moved?: number;
  /** The run is still going and the hash isn't compared yet, so the footer keeps waiting even after the replay ends. */
  pending?: boolean;
}

/** A run still in progress: real events so far, and a scan line only while a real job is running. */
export interface RoomsLive {
  lines: { id: string; label: string; value?: string; tone?: 'good' | 'bad' }[];
  scanning: boolean;
  note?: string;
}

/** The replay clock. It is linear, it never eases, and it runs for as long as the measured rehearsal did.
 *  `autoPlay: false` opens on the end state, with Replay one click away. `hold` keeps it before the first frame. */
export function useRehearsal(hero: PublicHero | null | undefined, { reduced = false, startDelay = 350, autoPlay = true, hold = false } = {}): RehearsalControl {
  const script = useMemo(() => (hero ? buildScript(hero) : null), [hero]);
  const [cue, setCue] = useState(-1);
  const [status, setStatus] = useState<RoomsStatus>('waiting');
  const [speed, setSpeedState] = useState(1);
  const [stop, setStop] = useState(-1);
  const clock = useRef(0);
  const speedRef = useRef(1);
  const raf = useRef(0);
  const timer = useRef(0);
  const onFrame = useRef(new Set<(t: number) => void>());

  const land = useCallback(
    (t: number) => {
      clock.current = t;
      onFrame.current.forEach((fn) => fn(t));
      if (!script) return;
      let latest = -1;
      for (const c of script.cues) {
        if (c > t) break;
        latest = c;
      }
      setCue((prev) => (prev === latest ? prev : latest));
    },
    [script],
  );

  const stopLoop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    window.clearTimeout(timer.current);
  }, []);

  const finish = useCallback(() => {
    if (!script) return;
    stopLoop();
    land(script.end);
    setStatus('done');
  }, [script, land, stopLoop]);

  const run = useCallback(
    (delay: number) => {
      if (!script) return;
      stopLoop();
      setStatus('waiting');
      setStop(-1);
      land(0);
      setCue(-1);
      timer.current = window.setTimeout(() => {
        setStatus('running');
        let last = performance.now();
        const frame = (now: number) => {
          // A long gap means a hidden tab or a stall. The replay waits instead of skipping what happened.
          const dt = Math.min(now - last, 100);
          last = now;
          const t = clock.current + dt * speedRef.current;
          if (t >= script.end) {
            finish();
            return;
          }
          land(t);
          raf.current = requestAnimationFrame(frame);
        };
        raf.current = requestAnimationFrame(frame);
      }, delay);
    },
    [script, land, stopLoop, finish],
  );

  useEffect(() => {
    if (!script) return;
    if (hold) {
      stopLoop();
      land(0);
      setCue(-1);
      setStatus('waiting');
      return stopLoop;
    }
    if (reduced || !autoPlay) {
      finish();
      return stopLoop;
    }
    run(startDelay);
    return stopLoop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, reduced, hold]);

  const replay = useCallback(() => run(120), [run]);
  const setSpeed = useCallback(
    (s: number) => {
      speedRef.current = s;
      setSpeedState(s);
      // Choosing a speed after the end means wanting to see it again at that speed.
      if (status === 'done' && !reduced) run(120);
    },
    [status, reduced, run],
  );

  const stepNext = useCallback(() => {
    if (!script) return;
    setStop((prev) => {
      const next = prev + 1;
      if (next >= script.stops.length) {
        land(script.end);
        return -1;
      }
      land(script.stops[next].at);
      return next;
    });
  }, [script, land]);

  return { script, cue, status, speed, stop, replay, setSpeed, finish, stepNext, clock, onFrame };
}

interface Palette {
  idle: string;
  bad: string;
  scan: string;
}

function readPalette(): Palette {
  return { idle: cssVar('--dot-idle'), bad: cssVar('--bad'), scan: cssVar('--ink-2') };
}

function sizeCanvas(canvas: HTMLCanvasElement, layout: DotLayout) {
  const dpr = dprNow();
  const w = Math.round(layout.width * dpr);
  const h = Math.round(layout.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d', { alpha: true });
  return { ctx, dpr, w, h };
}

/** Prod paints once. It repaints only if the box changes size or the theme flips, and never in response to the clock. */
const ProdField = memo(function ProdField({ layout, labels }: { layout: DotLayout; labels: TableInput[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const paints = useRef(0);
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const paint = () => {
      const { ctx, dpr } = sizeCanvas(canvas, layout);
      if (!ctx) return;
      const size = Math.max(1, Math.round(layout.dot * dpr));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = cssVar('--dot-idle');
      ctx.beginPath();
      for (let i = 0; i < layout.total; i++) ctx.rect(Math.round(layout.x[i] * dpr), Math.round(layout.y[i] * dpr), size, size);
      ctx.fill();
      paints.current++;
      canvas.dataset.paints = String(paints.current);
    };
    paint();
    return onThemeChange(paint);
  }, [layout]);
  return (
    <>
      <canvas ref={ref} className="rooms-canvas" data-room="prod" data-scale={layout.rowsPerDot} data-pitch={layout.pitch} aria-hidden="true" style={{ width: layout.width, height: layout.height }} />
      <FieldLabels layout={layout} rows={labels} />
    </>
  );
});

function FieldLabels({ layout, rows, dead }: { layout: DotLayout; rows: TableInput[]; dead?: (table: string) => { text: string; bad: boolean } | null }) {
  return (
    <>
      {layout.blocks.map((b) => {
        const state = dead?.(b.table) ?? null;
        const t = rows.find((r) => r.table === b.table);
        return (
          <span key={b.table} className={`rooms-label${state?.bad ? ' is-bad' : ''}${b.lines > 1 ? ' is-two-line' : ''}`} style={{ left: b.x, top: b.y, width: b.w }}>
            <span className="rooms-label-name">{b.table}</span>
            <span className="rooms-label-rows">{state?.text ?? num(t?.rows ?? b.rows)}</span>
          </span>
        );
      })}
    </>
  );
}

const HEAT_LEVELS = 6;

function CloneField({ layout, control, hero, labels, live }: { layout: DotLayout; control: RehearsalControl; hero: PublicHero; labels: TableInput[]; live: boolean }) {
  const script = control.script!;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const collapseRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  // When each dot dies, worked out once. 0 stays lit, 1 goes dark, 2 survives as a damaged ring.
  const fate = useMemo(() => {
    const dieAt = new Float32Array(layout.total).fill(Infinity);
    const kind = new Uint8Array(layout.total);
    for (const b of layout.blocks) {
      const w = script.windows.find((x) => x.table === b.table);
      if (!w || !b.dots) continue;
      const order = seededOrder(b.table, b.dots);
      const before = Math.max(1, w.rowsBefore);
      const dying = Math.min(b.dots, Math.round((w.deleted / before) * b.dots));
      const survivingRows = Math.max(0, w.rowsBefore - w.deleted);
      const damaged = Math.min(b.dots - dying, w.updated > 0 ? Math.max(1, Math.round((Math.min(w.updated, survivingRows) / before) * b.dots)) : 0);
      const affected = dying + damaged;
      for (let k = 0; k < affected; k++) {
        const i = b.first + order[k];
        dieAt[i] = w.start + (k / Math.max(1, affected - 1)) * (w.end - w.start);
        kind[i] = k < dying ? 1 : 2;
      }
    }
    return { dieAt, kind };
  }, [layout, script]);

  const palette = useRef<Palette | null>(null);
  const lastStatic = useRef(-1);
  const buckets = useRef<{ dpr: number; size: number; px: Int32Array; py: Int32Array } | null>(null);
  const hotLevels = useRef<Path2D[] | null>(null);

  const draw = useCallback(
    (t: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const [boot0, boot1] = script.boot;
      const [exec0, exec1] = script.exec;
      const [dead0, dead1] = script.destroy;

      // Still running: dots wait at 40%, because nothing about them has been measured yet.
      if (live) {
        const { ctx, dpr } = sizeCanvas(canvas, layout);
        if (!ctx) return;
        const size = Math.max(1, Math.round(layout.dot * dpr));
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = (palette.current ??= readPalette()).idle;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        for (let i = 0; i < layout.total; i++) ctx.rect(Math.round(layout.x[i] * dpr), Math.round(layout.y[i] * dpr), size, size);
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }

      // Collapse, flash and glow are transforms and opacity only.
      const collapse = collapseRef.current;
      const flash = flashRef.current;
      const glow = glowRef.current;
      if (collapse && flash) {
        if (t < dead0) {
          collapse.style.transform = '';
          flash.style.opacity = '0';
        } else if (t < dead1) {
          const k = (t - dead0) / Math.max(1, dead1 - dead0);
          collapse.style.transform = `scale(1, ${1 - k * 0.996})`;
          flash.style.opacity = String(k);
        } else if (t < script.crtEnd) {
          const k = (t - dead1) / Math.max(1, script.crtEnd - dead1);
          collapse.style.transform = `scale(${1 - k}, 0.004)`;
          flash.style.opacity = '1';
        } else {
          collapse.style.transform = 'scale(0, 0.004)';
          flash.style.opacity = '0';
        }
      }

      const moving = (t >= boot0 && t <= boot1 + 20) || (t >= exec0 && t <= exec1 + script.heatMs + 20);
      const staticId = t < boot0 ? 0 : t < exec0 ? 1 : t > exec1 ? 2 : -1;
      if (!moving && lastStatic.current === staticId) {
        if (glow && t >= dead1) glow.style.opacity = '0';
        return;
      }
      if (!moving) lastStatic.current = staticId;
      else lastStatic.current = -1;

      const { ctx, dpr } = sizeCanvas(canvas, layout);
      if (!ctx) return;
      const pal = (palette.current ??= readPalette());
      if (!buckets.current || buckets.current.dpr !== dpr || buckets.current.px.length !== layout.total) {
        const px = new Int32Array(layout.total);
        const py = new Int32Array(layout.total);
        for (let i = 0; i < layout.total; i++) {
          px[i] = Math.round(layout.x[i] * dpr);
          py[i] = Math.round(layout.y[i] * dpr);
        }
        buckets.current = { dpr, size: Math.max(1, Math.round(layout.dot * dpr)), px, py };
      }
      const { px, py, size } = buckets.current;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (t < exec0) {
        // Boot: a 1 px line runs top to bottom, and dots rise from 40% to full as it passes.
        const scanY = t <= boot0 ? -1 : t >= boot1 ? Infinity : ((t - boot0) / Math.max(1, boot1 - boot0)) * layout.height * dpr;
        ctx.fillStyle = pal.idle;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        for (let i = 0; i < layout.total; i++) if (py[i] <= scanY) ctx.rect(px[i], py[i], size, size);
        ctx.fill();
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        for (let i = 0; i < layout.total; i++) if (py[i] > scanY) ctx.rect(px[i], py[i], size, size);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (t > boot0 && t < boot1) {
          ctx.fillStyle = pal.scan;
          ctx.fillRect(0, Math.round(scanY), canvas.width, Math.max(1, Math.round(dpr)));
        }
        if (glow) glow.style.opacity = '0';
        return;
      }

      // Execute: neutral, then full red, then off. Damaged rows stay as hollow red rings.
      const { dieAt, kind } = fate;
      const heat = script.heatMs;
      ctx.fillStyle = pal.idle;
      ctx.beginPath();
      for (let i = 0; i < layout.total; i++) if (t < dieAt[i]) ctx.rect(px[i], py[i], size, size);
      ctx.fill();

      // Sort the hot dots by how far their red has decayed, then draw each level once.
      const levels = (hotLevels.current ??= Array.from({ length: HEAT_LEVELS }, () => new Path2D()));
      for (let l = 0; l < HEAT_LEVELS; l++) levels[l] = new Path2D();
      let hot = 0;
      for (let i = 0; i < layout.total; i++) {
        const dt = t - dieAt[i];
        if (dt < 0 || dt >= heat) continue;
        levels[Math.floor((dt / heat) * HEAT_LEVELS)].rect(px[i], py[i], size, size);
        hot++;
      }
      // Red needs a measured harm. A plan that passed dissolves in neutral.
      const heatColour = script.harmful ? pal.bad : pal.scan;
      ctx.fillStyle = heatColour;
      for (let l = 0; l < HEAT_LEVELS; l++) {
        ctx.globalAlpha = 1 - l / HEAT_LEVELS;
        ctx.fill(levels[l]);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = heatColour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < layout.total; i++) if (kind[i] === 2 && t - dieAt[i] >= 0) ctx.rect(px[i] + 0.5, py[i] + 0.5, size - 1, size - 1);
      ctx.stroke();

      // The one soft effect: a brief red afterglow while the clone dies.
      if (glow) glow.style.opacity = script.harmful ? String(Math.min(0.16, hot / 1400)) : '0';
    },
    [layout, script, fate, live],
  );

  useEffect(() => {
    palette.current = null;
    lastStatic.current = -1;
    const fns = control.onFrame.current;
    fns.add(draw);
    draw(control.clock.current);
    const off = onThemeChange(() => {
      palette.current = null;
      lastStatic.current = -1;
      draw(control.clock.current);
    });
    return () => {
      fns.delete(draw);
      off();
    };
  }, [draw, control.onFrame, control.clock]);

  const cue = control.cue;
  const dead = useCallback(
    (table: string) => {
      const w = script.windows.find((x) => x.table === table);
      if (!w || w.end > cue) return null;
      // What's left. A damaged table shows how many of its rows were updated, and its dots are rings.
      return { text: num(w.rowsAfter === 0 ? 0 : w.updated), bad: script.harmful };
    },
    [script, cue],
  );
  const gone = !live && cue >= script.crtEnd;
  const words = teardownWords(hero.teardown);

  return (
    <>
      <div ref={glowRef} className="rooms-glow" aria-hidden="true" />
      <div ref={collapseRef} className="rooms-collapse" style={gone ? { visibility: 'hidden' } : undefined}>
        <canvas ref={canvasRef} className="rooms-canvas" data-room="clone" aria-hidden="true" style={{ width: layout.width, height: layout.height }} />
        <FieldLabels layout={layout} rows={labels} dead={dead} />
        <div ref={flashRef} className="rooms-flash" aria-hidden="true" />
      </div>
      {gone && (
        <div className="rooms-gone">
          <DotWords first="Clone" second={words.clean ? 'gone' : 'check'} className="rooms-gone-word" />
          <div className="rooms-gone-line">{words.text}</div>
        </div>
      )}
    </>
  );
}

function DotWords({ first, second, className = '' }: { first: string; second: string; className?: string }) {
  return (
    <div className={`t-dot dot-words ${className}`} data-words={`${first}: ${second}`}>
      <span className="sr-only">
        {first}: {second}
      </span>
      <span aria-hidden="true">{first}</span>
      <i className="dot-colon" aria-hidden="true" />
      <span aria-hidden="true">{second}</span>
    </div>
  );
}

const LEDGER_ROW_H = 16;

function Ledger({ script, cue, inline }: { script: Script; cue: number; inline?: boolean }) {
  const box = useRef<HTMLOListElement>(null);
  const [fits, setFits] = useState(99);
  useLayoutEffect(() => {
    const parent = box.current?.parentElement;
    if (!parent || inline) return;
    const measure = () => setFits(Math.max(4, Math.floor((parent.clientHeight - 20) / LEDGER_ROW_H)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [inline]);
  // Like a terminal: when the column is full, the oldest lines scroll off the top.
  const rows = script.ledger.filter((r) => r.at <= cue);
  const list = inline ? script.ledger : rows.slice(-fits);
  return (
    <ol className="ledger" ref={box}>
      {list.map((r) => (
        <li key={r.id} className={`ledger-row${r.skip ? ' is-skip' : ''}${r.table ? ' is-table' : ''}`}>
          <span className="ledger-label" title={r.table ? r.label : undefined}>
            {r.lock && <LockTick />}
            {r.label}
          </span>
          {r.value && <span className={`ledger-value${r.tone ? ` is-${r.tone}` : ''}`}>{r.value}</span>}
        </li>
      ))}
    </ol>
  );
}

function LockTick() {
  return (
    <svg className="ledger-lock" width="10" height="11" viewBox="0 0 10 11" aria-label="locked">
      <path d="M2.5 4.5V3a2.5 2.5 0 0 1 5 0v1.5" fill="none" stroke="currentColor" />
      <rect x="1" y="4.5" width="8" height="6" fill="currentColor" />
    </svg>
  );
}

function fitStyle(chars: number): CSSProperties {
  return { '--chars': chars } as CSSProperties;
}

export function TwoRooms({
  control,
  hero,
  phone = false,
  seeded = false,
  sourceLine,
  unit = 'rows',
  prod: prodView,
  live,
}: {
  control: RehearsalControl;
  hero: PublicHero;
  phone?: boolean;
  /** The dollars are records on a seeded demo database, not money anyone spent, so the labels say so. */
  seeded?: boolean;
  /** Receives the printed scale once the layout is known, so a caption can state it. */
  sourceLine?: (scale: string) => void;
  /** What a dot stands for. A Linux host is drawn as files. */
  unit?: 'rows' | 'files';
  /** Replaces the default "the rehearsal left the hash alone" reading of prod's footer. */
  prod?: ProdView | null;
  live?: RoomsLive | null;
}) {
  const { script, cue } = control;
  const fieldRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<DotLayout | null>(null);
  const tables = useMemo(
    () =>
      asInputs(hero.snapshot_rows).map((t) => ({
        ...t,
        widest: hero.tables.find((x) => x.table === t.table)?.updated ?? (live ? t.rows * 2 : undefined),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hero.snapshot_rows, hero.tables, !!live],
  );
  // Polling and switching attempts hand over new objects with the same contents. The layout, and so prod's paint,
  // only changes if the tables really did.
  const tablesKey = useMemo(() => tables.map((t) => `${t.table}:${t.rows}`).join('|'), [tables]);
  const layoutFor = useRef('');

  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setLayout((prev) => {
        if (prev && prev.width === w && prev.height === h && layoutFor.current === tablesKey) return prev;
        layoutFor.current = tablesKey;
        // A server has hundreds of files where a database has tens of thousands of rows, so its dots can be finer.
        const smallest = unit === 'files' ? (phone ? 2 : 1) : phone ? 50 : 5;
        const usual = phone ? { minScale: smallest, minPitch: 4, maxPitch: 6 } : { minScale: smallest, minPitch: 5, maxPitch: 9 };
        // Too tight for the usual dots: finer ones, rather than an empty room.
        return layoutDots(tables, w, h, usual) ?? layoutDots(tables, w, h, { minScale: smallest, minPitch: 3, maxPitch: 4 });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tablesKey, phone]);

  useEffect(() => {
    if (layout) sourceLine?.(`1 dot = ${num(layout.rowsPerDot)} ${layout.rowsPerDot === 1 ? unit.replace(/s$/, '') : unit}`);
  }, [layout, sourceLine, unit]);

  // Scrolled away mid-replay: skip to the end, so coming back doesn't play it again.
  const finish = control.finish;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let seen = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) seen = true;
      else if (seen) finish();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [finish]);

  const hand = useHand(control, script, stageRef);
  if (!script) return null;

  const steps = script.windows.filter((w) => w.end <= cue);
  const lastStep = steps[steps.length - 1];
  const execDone = cue >= script.exec[1];
  const rows = execDone ? (script.rowsChanged ?? lastStep?.running ?? null) : (lastStep?.running ?? null);
  const guardrailsLanded = cue >= script.guardrailsAt;
  const prodLanded = cue >= script.prodAt;
  const lastLine = [...script.ledger].reverse().find((r) => r.at <= cue);
  // Three states. Null means the hash wasn't compared, so nothing is claimed either way.
  const prodState = hero.prod.unchanged === true ? 'same' : hero.prod.unchanged === false ? 'moved' : 'unknown';
  const prodWord = { same: 'same', moved: 'moved', unknown: 'unknown' }[prodState];
  const prodTone = prodState === 'same' ? 'good' : prodState === 'moved' ? 'bad' : 'neutral';
  const prodVerdict = { same: 'Unchanged', moved: 'Changed', unknown: 'Not measured' }[prodState];
  const total = tables.reduce((a, t) => a + t.rows, 0);
  const prodEvent = hero.timeline.find((e) => e.type === 'prod_checked');
  const prodOffset = prodEvent ? `+${prodEvent.t.toFixed(1)} s` : null;
  const latest = prodLanded && prodOffset ? { label: 'hash checked', value: prodOffset, tone: undefined } : lastLine;

  return (
    <Frame className="rooms" data-status={control.status}>
      <div className="rooms-grid" ref={stageRef}>
        <section className="room room-clone" aria-label="The clone">
          <header className="room-head">
            <Label>Clone</Label>
            {hero.command.length > 0 && (
              <code className="room-command">
                <span aria-hidden="true">$ </span>
                {hero.command.join(' ')}
              </code>
            )}
            <span className="room-head-note">no NIC</span>
          </header>
          <div className="room-body">
            {!phone && (
              <div className="room-ledger">{live ? <LiveLedger lines={live.lines} /> : <Ledger script={script} cue={cue} />}</div>
            )}
            <div className="room-field room-field-clone">
              {layout && <CloneField layout={layout} control={control} hero={hero} labels={tables} live={!!live} />}
              {live?.scanning && <i className="rooms-scan" aria-hidden="true" />}
            </div>
          </div>
          <footer className="room-foot room-foot-clone">
            <div className="foot-big" style={fitStyle(script.loss?.text.length ?? 15)}>
              {execDone && script.loss ? (
                <span className="foot-figure t-num-xl is-bad" key="loss">
                  {script.loss.text}
                </span>
              ) : (
                <span className="foot-rows" key="rows">
                  {rows === null ? <span className="foot-pending">{live?.note ?? 'Nothing measured yet'}</span> : <Measured value={rows} format={num} source="report.tables, running sum" className="t-num-l" />}
                  {rows !== null && <span className="foot-rows-label">{rows === 1 ? unit.slice(0, -1) : unit} changed</span>}
                </span>
              )}
            </div>
            <div className="foot-caption">{execDone && script.loss ? `${script.loss.name}${seeded ? ' on this seeded demo' : ''}, measured on the clone.${seeded ? ' All dollars here are seeded.' : ''}` : ' '}</div>
            {!live && (
            <dl className="foot-cells">
              {/* With no dollar figure, this number is already the big one above. */}
              {script.loss && (
                <div className={execDone ? '' : 'is-pending'}>
                  <dt>{unit === 'files' ? 'Files changed' : 'Rows changed'}</dt>
                  <dd>
                    <Measured value={script.rowsChanged} format={num} />
                  </dd>
                </div>
              )}
              <div className={guardrailsLanded ? '' : 'is-pending'}>
                <dt>Guardrails</dt>
                <dd className={guardrailsLanded && script.guardrailsFailed > 0 ? 'is-bad-word' : undefined}>
                  <Mark tone={script.guardrailsFailed > 0 ? 'bad' : hero.guardrails.total > 0 ? 'good' : 'neutral'} size={12} /> {hero.guardrails.passed} of {hero.guardrails.total} passed, {script.guardrailsFailed} failed
                </dd>
              </div>
              {[...script.others, ...(hero.extras ?? [])].slice(0, 2).map((o) => (
                <div key={o.name} className={execDone ? '' : 'is-pending'}>
                  <dt>{o.name}</dt>
                  <dd>{o.text}</dd>
                </div>
              ))}
            </dl>
            )}
          </footer>
        </section>

        <div className="rooms-seam" aria-hidden="true">
          <i ref={hand} className="rooms-hand" />
        </div>

        {phone && (
          <div className="rooms-latest" aria-hidden="true">
            {live ? (
              <span>{live.lines[live.lines.length - 1]?.label ?? live.note ?? 'Starting'}</span>
            ) : latest ? (
              <>
                <span>{latest.label}</span>
                <span className={latest.tone ? `is-${latest.tone}` : undefined}>{latest.value}</span>
              </>
            ) : (
              <span>$ {hero.command.join(' ')}</span>
            )}
          </div>
        )}

        <section className="room room-prod" aria-label="Prod">
          <header className="room-head">
            <Label>Prod</Label>
            <span className="room-head-note room-head-note-end">{hero.prod.measured_from ?? 'control plane'}</span>
          </header>
          {!!prodView?.moved && <i className="rooms-sweep" key={prodView.moved} aria-hidden="true" />}
          <div className="room-body">
            <div className="room-field room-field-prod" ref={fieldRef}>
              {layout && <ProdField layout={layout} labels={tables} />}
              {!layout && tables.length > 0 && <p className="room-undrawn">Too many {unit === 'files' ? 'directories' : 'tables'} to draw at this size.</p>}
            </div>
            {!phone && (
              <dl className="room-ledger room-ledger-cold">
                {tables.length > 0 && unit === 'rows' && (
                  <div className="ledger-row">
                    <dt className="ledger-label">tables</dt>
                    <dd className="ledger-value">{num(tables.length)}</dd>
                  </div>
                )}
                {tables.length > 0 && (
                  <div className="ledger-row">
                    <dt className="ledger-label">{unit}</dt>
                    <dd className="ledger-value">{num(total)}</dd>
                  </div>
                )}
                {layout && tables.length > 0 && (
                  <div className="ledger-row">
                    <dt className="ledger-label">1 dot</dt>
                    <dd className="ledger-value">
                      {num(layout.rowsPerDot)} {layout.rowsPerDot === 1 ? unit.replace(/s$/, '') : unit}
                    </dd>
                  </div>
                )}
                {prodLanded && (prodView?.checkedAt ?? prodOffset) && (
                  <div className="ledger-row is-skip">
                    <dt className="ledger-label">hash checked</dt>
                    <dd className="ledger-value">{prodView?.checkedAt ?? prodOffset}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>
          <footer className={`room-foot room-foot-prod${prodLanded ? ' is-landed' : ''}`} aria-live="polite">
            {prodLanded && prodView && !prodView.pending ? (
              <>
                <div className="prod-word">
                  <DotWords first="Prod" second={prodView.word} className={`prod-same is-${prodView.tone}`} />
                  <span className={`prod-verdict is-${prodView.tone}`}>
                    <Mark tone={prodView.tone} size={13} /> {prodView.verdict}
                  </span>
                </div>
                <dl className="prod-hashes">
                  {prodView.hashes.map((h) => (
                    <div key={h.label}>
                      <dt>{h.label}</dt>
                      {/* A hash only ever changes when the hash really changed, and then through the digit slot. */}
                      <dd>
                        <Measured value={h.value} format={(v) => short(v, 12)} source={h.value ?? undefined} />
                        {h.value && <CopyButton value={h.value} />}
                      </dd>
                    </div>
                  ))}
                </dl>
                {prodView.note && <p className="prod-note">{prodView.note}</p>}
              </>
            ) : prodLanded && !prodView ? (
              <>
                <div className="prod-word">
                  <DotWords first="Prod" second={prodWord} className={`prod-same is-${prodTone}`} />
                  <span className={`prod-verdict is-${prodTone}`}>
                    <Mark tone={prodTone} size={13} /> {prodVerdict}
                  </span>
                </div>
                <dl className="prod-hashes">
                  <div>
                    <dt>before</dt>
                    <dd>{short(hero.prod.before, 12)}</dd>
                  </div>
                  <div>
                    <dt>after</dt>
                    <dd>{short(hero.prod.after, 12)}</dd>
                  </div>
                </dl>
                <p className="prod-note">Measured from the {hero.prod.measured_from ?? 'control plane'}.</p>
              </>
            ) : (
              <p className="prod-waiting">{prodView?.waiting ?? 'Not checked yet in this replay. The hash is measured last.'}</p>
            )}
          </footer>
        </section>
      </div>
      {phone && (
        <details className="fold rooms-events">
          <summary>All events from this run</summary>
          <div className="fold-body">{live ? <LiveLedger lines={live.lines} /> : <Ledger script={script} cue={script.end} inline />}</div>
        </details>
      )}
    </Frame>
  );
}

function LiveLedger({ lines }: { lines: RoomsLive['lines'] }) {
  return (
    <ol className="ledger">
      {lines.map((r) => (
        <li key={r.id} className="ledger-row">
          <span className="ledger-label">{r.label}</span>
          {r.value && <span className={`ledger-value${r.tone ? ` is-${r.tone}` : ''}`}>{r.value}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Replay, speed and, for anyone who asked for less motion, a stepper through the phases instead. */
export function ReplayControls({ control, reduced, children }: { control: RehearsalControl; reduced: boolean; children?: ReactNode }) {
  const stops = control.script?.stops ?? [];
  return (
    <>
      {reduced ? (
        <button type="button" className="btn" onClick={control.stepNext} aria-live="polite">
          {control.stop < 0 ? 'Step through it' : `Next. Step ${control.stop + 1} of ${stops.length}: ${stops[control.stop]?.label}`}
        </button>
      ) : (
        <>
          <button type="button" className="btn" onClick={control.replay}>
            Replay
          </button>
          <div className="seg" role="group" aria-label="Replay speed">
            {[
              { label: '1×', value: 1, name: 'Real speed' },
              { label: '¼×', value: 0.25, name: 'Quarter speed' },
            ].map((s) => (
              <button key={s.value} type="button" className={control.speed === s.value ? 'seg-btn is-on' : 'seg-btn'} aria-pressed={control.speed === s.value} aria-label={s.name} onClick={() => control.setSpeed(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}
      {children}
    </>
  );
}

/** A tick that runs down the seam with the clock, in step with the measured time. */
function useHand(control: RehearsalControl, script: Script | null, stage: React.RefObject<HTMLDivElement>) {
  const hand = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!script) return;
    const fns = control.onFrame.current;
    const move = (t: number) => {
      const el = hand.current;
      if (!el) return;
      const h = stage.current?.clientHeight ?? 0;
      const k = Math.min(1, t / script.end);
      if (k <= 0 || k >= 1) {
        el.style.opacity = '0';
        return;
      }
      el.style.opacity = '1';
      el.style.transform = `translateY(${(k * h).toFixed(1)}px)`;
    };
    fns.add(move);
    return () => {
      fns.delete(move);
    };
  }, [control.onFrame, script, stage]);
  return hand;
}

/** No measurement stored: two empty frames and the words. No dots, because dots imply row counts. */
export function TwoRoomsEmpty({ loading, clone, prod }: { loading: boolean; clone?: ReactNode; prod?: ReactNode }) {
  return (
    <Frame className="rooms rooms-empty">
      <div className="rooms-grid">
        <section className="room room-clone" aria-label="The clone">
          <header className="room-head">
            <Label>Clone</Label>
          </header>
          <div className="room-body room-body-empty">
            {clone ??
              (!loading && (
                <div className="rooms-notyet">
                  <div className="t-display-m">Not measured yet</div>
                  <p>No rehearsal of a real incident is stored on this build, so there is nothing to replay. Nothing is estimated.</p>
                </div>
              ))}
          </div>
        </section>
        <div className="rooms-seam" aria-hidden="true" />
        <section className="room room-prod" aria-label="Prod">
          <header className="room-head">
            <Label>Prod</Label>
          </header>
          <div className="room-body room-body-empty">{prod}</div>
        </section>
      </div>
    </Frame>
  );
}
