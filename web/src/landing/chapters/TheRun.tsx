import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppliedExample, PublicHero } from '../../api/types';
import { isNum, num, short, when } from '../../lib/format';
import { Mark } from '../../ui/bits';
import { Frame } from '../../ui/Frame';
import { Measured } from '../../ui/Measured';
import { barsFromPhases, RunGantt } from '../../ui/RunGantt';
import { sourceLine } from '../../ui/Figure';
import { useScrub } from '../../ui/useScrub';
import { useLanding } from '../context';
import { ChapterHead, pad, Pager, Segments, useMode } from './parts';

const STAGES = [
  { word: 'Frozen', line: 'The plan is frozen and hashed. Change a byte and the hash changes.' },
  { word: 'Gated', line: 'A static gate, rules that read the SQL without running it, looks at the plan first.' },
  { word: 'Cloned', line: 'A clone of prod boots in a microVM, a small throwaway virtual machine with no network.' },
  { word: 'Rehearsed', line: 'The plan runs on the clone. Postgres counts every row, cascades included.' },
  { word: 'Checked', line: "Frozen guardrails check the result. The agent can't edit them." },
  { word: 'Approved', line: 'A different person approves the exact hashes.' },
  { word: 'Applied', line: 'The same plan runs on prod, in one transaction.' },
  { word: 'Verified', line: 'If counts differ from the rehearsal, it rolls back.' },
];

// Where each layer sits at each stage. Heights are in drawing units above the prod slab, which has no entry because it never moves.
interface Pose {
  plan: number;
  planO: number;
  gate: number;
  clone: number;
  cloneO: number;
  hurt: number;
  pins: number;
  sheet: number;
  sheetO: number;
}
const POSES: Pose[] = [
  { plan: 226, planO: 1, gate: 0, clone: 40, cloneO: 0, hurt: 0, pins: 0, sheet: 170, sheetO: 0 },
  { plan: 196, planO: 1, gate: 1, clone: 40, cloneO: 0, hurt: 0, pins: 0, sheet: 170, sheetO: 0 },
  { plan: 196, planO: 1, gate: 0, clone: 126, cloneO: 1, hurt: 0, pins: 0, sheet: 170, sheetO: 0 },
  { plan: 138, planO: 1, gate: 0, clone: 126, cloneO: 1, hurt: 1, pins: 0, sheet: 170, sheetO: 0 },
  { plan: 138, planO: 0, gate: 0, clone: 126, cloneO: 1, hurt: 1, pins: 1, sheet: 170, sheetO: 0 },
  { plan: 138, planO: 0, gate: 0, clone: 126, cloneO: 0, hurt: 1, pins: 0, sheet: 170, sheetO: 1 },
  { plan: 138, planO: 0, gate: 0, clone: 126, cloneO: 0, hurt: 1, pins: 0, sheet: 44, sheetO: 1 },
  { plan: 138, planO: 0, gate: 0, clone: 126, cloneO: 0, hurt: 1, pins: 0, sheet: 44, sheetO: 1 },
];

const iso = (x: number, y: number, z = 0): [number, number] => [(x - y) * 0.866, (x + y) * 0.5 - z];
const pt = ([x, y]: [number, number]) => `${x.toFixed(1)},${y.toFixed(1)}`;

/** A slab centred on the origin, as three polygons. */
function slab(w: number, d: number, h: number) {
  const x = w / 2;
  const y = d / 2;
  return {
    top: [iso(-x, -y, h), iso(x, -y, h), iso(x, y, h), iso(-x, y, h)].map(pt).join(' '),
    right: [iso(x, -y, h), iso(x, y, h), iso(x, y, 0), iso(x, -y, 0)].map(pt).join(' '),
    left: [iso(-x, y, h), iso(x, y, h), iso(x, y, 0), iso(-x, y, 0)].map(pt).join(' '),
  };
}

function Slab({ w, d, h, className }: { w: number; d: number; h: number; className: string }) {
  const s = useMemo(() => slab(w, d, h), [w, d, h]);
  return (
    <g className={className}>
      <polygon className="face-left" points={s.left} />
      <polygon className="face-right" points={s.right} />
      <polygon className="face-top" points={s.top} />
    </g>
  );
}

/** Dots on a slab's top, so the clone and prod read as the same thing. */
function TopDots({ w, d, h, n, className }: { w: number; d: number; h: number; n: number; className: string }) {
  const dots = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        out.push(iso(((i + 0.5) / n - 0.5) * w * 0.88, ((j + 0.5) / n - 0.5) * d * 0.88, h));
      }
    }
    return out;
  }, [w, d, h, n]);
  return (
    <g className={className}>
      {dots.map(([x, y], i) => (
        <rect key={i} x={x - 1.5} y={y - 1.5} width="3" height="3" />
      ))}
    </g>
  );
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function poseAt(s: number): Pose {
  const i = Math.min(STAGES.length - 1, Math.floor(s));
  const from = POSES[Math.max(0, i - 1)];
  const to = POSES[i];
  // Each stage moves in its first 45%, then holds so the sentence can be read.
  const k = i === 0 ? 1 : Math.min(1, (s - i) / 0.45);
  const out = {} as Pose;
  for (const key of Object.keys(to) as (keyof Pose)[]) out[key] = lerp(from[key], to[key], k);
  return out;
}

function apply(svg: SVGSVGElement, pose: Pose) {
  const set = (name: string, z: number, opacity: number) => {
    const el = svg.querySelector<SVGGElement>(`[data-l="${name}"]`);
    if (!el) return;
    el.setAttribute('transform', `translate(0 ${(-z).toFixed(1)})`);
    el.style.opacity = opacity.toFixed(3);
    el.style.visibility = opacity <= 0.001 ? 'hidden' : 'visible';
  };
  set('clone', pose.clone, pose.cloneO);
  set('plan', pose.plan, pose.planO);
  set('gate', 176, pose.gate);
  set('sheet', pose.sheet, pose.sheetO);
  set('pins', pose.clone, pose.pins * pose.cloneO);
  const hurt = svg.querySelector<SVGGElement>('[data-l="hurt"]');
  if (hurt) hurt.style.opacity = pose.hurt.toFixed(3);
}

function Pins({ passed, total }: { passed: number; total: number }) {
  const w = 300;
  const items = Array.from({ length: total }, (_, i) => {
    const edge = (i / total) * 4;
    const side = Math.floor(edge);
    const f = edge - side;
    const h = w / 2 - 8;
    const at: [number, number] = side === 0 ? [-h + f * 2 * h, -h] : side === 1 ? [h, -h + f * 2 * h] : side === 2 ? [h - f * 2 * h, h] : [-h, h - f * 2 * h];
    return { at, ok: i < passed };
  });
  return (
    <g data-l="pins">
      {items.map(({ at, ok }, i) => {
        const [x0, y0] = iso(at[0], at[1], 10);
        const [x1, y1] = iso(at[0], at[1], 42);
        return (
          <g key={i} className={ok ? 'pin is-good' : 'pin is-bad'}>
            <line className="pin-halo" x1={x0} y1={y0} x2={x1} y2={y1} />
            <line x1={x0} y1={y0} x2={x1} y2={y1} />
            {ok ? <circle cx={x1} cy={y1} r="5.5" /> : <rect x={x1 - 5} y={y1 - 5} width="10" height="10" />}
          </g>
        );
      })}
    </g>
  );
}

function Stack({ hero, svgRef, compact }: { hero: PublicHero | null; svgRef?: React.Ref<SVGSVGElement>; compact?: boolean }) {
  const g = hero?.guardrails;
  return (
    <svg ref={svgRef} className={`stack${compact ? ' is-compact' : ''}`} viewBox="-290 -320 580 500" role="img" aria-label="A stack: the prod slab at the bottom, which never moves, with the clone layer above it.">
      {/* Prod is drawn once and has no transform. */}
      <g className="stack-prod">
        <Slab w={300} d={300} h={36} className="slab slab-prod" />
        <TopDots w={300} d={300} h={36} n={13} className="dots" />
        <text className="stack-word" x="40" y="128" transform="matrix(.866 .5 -.866 .5 0 -2)" textAnchor="middle">
          PROD
        </text>
      </g>
      <g data-l="clone">
        <Slab w={300} d={300} h={10} className="slab slab-clone" />
        <TopDots w={300} d={300} h={10} n={13} className="dots" />
        <g data-l="hurt" style={{ opacity: 0 }}>
          <Slab w={300} d={300} h={10} className="slab slab-hurt" />
        </g>
        {/* Named on its own face, so the red layer reads as the clone and never as prod. */}
        <text className="stack-word stack-word-clone" x="40" y="128" transform="matrix(.866 .5 -.866 .5 0 24)" textAnchor="middle">
          CLONE
        </text>
      </g>
      {g && g.total > 0 && <Pins passed={g.passed} total={g.total} />}
      <g data-l="gate">
        <polygon className="gate" points={slab(200, 164, 0).top} />
      </g>
      <g data-l="sheet">
        <polygon className="sheet-dashed" points={slab(180, 136, 0).top} />
      </g>
      <g data-l="plan">
        <Slab w={180} d={136} h={5} className="slab slab-plan" />
        {[-34, -14, 6, 26].map((y) => {
          const [x1, y1] = iso(-70, y, 5);
          const [x2, y2] = iso(y === 26 ? 10 : 66, y, 5);
          return <line key={y} className="plan-line" x1={x1} y1={y1} x2={x2} y2={y2} />;
        })}
      </g>
    </svg>
  );
}

const FIRST_APPLIED_STAGE = 5;

const valueRow = (k: string, v: ReactNode, tone?: 'good' | 'bad') => (
  <div key={k}>
    <dt>{k}</dt>
    <dd className={tone ? `is-${tone}` : undefined}>{v}</dd>
  </div>
);

/** A word only when the record has one. A failure says so, and a missing value claims nothing. */
function proved(ok: boolean | null | undefined, yes: string, no: string): ReactNode {
  if (ok === null || ok === undefined) return 'Not measured';
  return (
    <>
      <Mark tone={ok ? 'good' : 'bad'} size={12} /> {ok ? yes : no}
    </>
  );
}

/** The replay above was blocked, so the last stages come from a run that got there, and it says so in plain words. */
function AppliedValues({ example, stage, blocked }: { example: AppliedExample; stage: number; blocked: boolean }) {
  const { enter, guestOff, busy } = useLanding();
  const href = `/runs/${encodeURIComponent(example.run_id)}`;
  const counts = Object.entries(example.actual_counts ?? {});
  const onProd = counts.reduce((sum, [, c]) => sum + (c.ins ?? 0) + (c.upd ?? 0) + (c.del ?? 0), 0);
  const words = counts.flatMap(([table, c]) =>
    [
      [c.ins, 'inserted'],
      [c.upd, 'updated'],
      [c.del, 'deleted'],
    ]
      .filter(([n]) => isNum(n) && n > 0)
      .map(([n, verb]) => `${table}: ${num(n)} ${verb}`),
  );
  const matched = counts.length > 0 && isNum(example.rows_changed) ? onProd === example.rows_changed : null;
  return (
    <>
      <p className="run-values-other">
        {blocked ? 'The replay above was blocked, so it never got here. This is a different run that did: ' : 'This is a different run from the replay above: '}
        {guestOff ? (
          <code className="mono">{example.run_id}</code>
        ) : (
          <a
            className="mono"
            href={href}
            onClick={(e) => {
              e.preventDefault();
              if (!busy) void enter(href);
            }}
          >
            {example.run_id}
          </a>
        )}
        , measured {when(example.measured_at)}.
      </p>
      {stage === FIRST_APPLIED_STAGE && (
        <dl className="run-values">
          {valueRow('plan hash', short(example.plan_hash, 12))}
          {valueRow('second clone', proved(example.reproduced, 'same result', 'different result'), example.reproduced === true ? 'good' : example.reproduced === false ? 'bad' : undefined)}
        </dl>
      )}
      {stage === FIRST_APPLIED_STAGE + 1 && (
        <dl className="run-values">
          {valueRow('rows changed', <Measured value={example.rows_changed} format={num} />)}
          {valueRow('prod before', short(example.prod_before, 12))}
          {valueRow('prod after', short(example.prod_after, 12))}
        </dl>
      )}
      {stage >= FIRST_APPLIED_STAGE + 2 && (
        <dl className="run-values">
          {valueRow('on prod', words.length ? words.join(', ') : 'Not measured')}
          {valueRow('against rehearsal', proved(matched, `${num(example.rows_changed)} rows, same count`, `${num(example.rows_changed)} rows, different count`), matched === true ? 'good' : matched === false ? 'bad' : undefined)}
          {valueRow('undo, on a clone', proved(example.undo_verified, 'proved', 'not proved'), example.undo_verified === true ? 'good' : example.undo_verified === false ? 'bad' : undefined)}
        </dl>
      )}
    </>
  );
}

function values(hero: PublicHero | null, example: AppliedExample | null, stage: number): ReactNode {
  const blocked = !!hero?.timeline.some((e) => e.type === 'run_blocked');
  if (stage >= FIRST_APPLIED_STAGE && example) return <AppliedValues example={example} stage={stage} blocked={blocked} />;
  if (!hero) return <p className="run-values-none">Not measured yet</p>;
  const at = (type: string) => hero.timeline.find((e) => e.type === type)?.t;
  const off = (t: number | undefined) => (t === undefined ? null : `+${Math.round(t * 1000).toLocaleString('en-US')} ms`);
  const row = valueRow;
  switch (stage) {
    case 0:
      return (
        <dl className="run-values">
          {row('plan hash', short(hero.plan_hash, 12))}
          {row('frozen at', off(at('plan_frozen')))}
        </dl>
      );
    case 1:
      return <dl className="run-values">{row('static gate at', off(at('static_gate')))}</dl>;
    case 2:
      return (
        <dl className="run-values">
          {row('boot', typeof hero.phases.clone_boot_ms === 'number' ? `${Math.round(hero.phases.clone_boot_ms)} ms` : null)}
          {hero.probes.map((p) => row(p.label ?? 'probe', p.result, p.result === 'BLOCKED' ? 'good' : 'bad'))}
        </dl>
      );
    case 3:
      return (
        <>
          <RunGantt attempts={[{ label: 'Rehearsal', bars: barsFromPhases(hero.phases) }]} />
          <dl className="run-values run-values-two">
            {row('rows changed', <Measured value={hero.totals.rows_changed} format={num} />, 'bad')}
            {row('via cascade', <Measured value={hero.totals.rows_via_cascade} format={num} />)}
          </dl>
        </>
      );
    case 4: {
      const failed = hero.guardrails.total - hero.guardrails.passed;
      return (
        <dl className="run-values run-values-two">
          {row('guardrails passed', `${hero.guardrails.passed} of ${hero.guardrails.total}`)}
          {row('failed', num(failed), failed > 0 ? 'bad' : 'good')}
        </dl>
      );
    }
    default:
      return blocked ? <p className="run-values-none">This run was blocked at the guardrails, so it never got here.</p> : null;
  }
}

function StageCard({ hero, example, index }: { hero: PublicHero | null; example: AppliedExample | null; index: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    if (ref.current) apply(ref.current, POSES[index]);
  }, [index, hero]);
  const s = STAGES[index];
  return (
    <div className="run-card">
      <span className="t-label">
        {pad(index + 1)} · {s.word}
      </span>
      <p className="run-card-line">{s.line}</p>
      <Stack hero={hero} svgRef={ref} compact />
      <div className="run-values-box">{values(hero, example, index)}</div>
    </div>
  );
}

export function TheRun({ hero, example }: { hero: PublicHero | null; example: AppliedExample | null }) {
  const mode = useMode();
  const sectionRef = useRef<HTMLElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [stage, setStage] = useState(0);
  const lastS = useRef(0);

  const draw = useCallback((p: number) => {
    const s = Math.min(STAGES.length - 0.001, p * STAGES.length);
    lastS.current = s;
    if (svgRef.current) apply(svgRef.current, poseAt(s));
    const next = Math.floor(s);
    setStage((prev) => (prev === next ? prev : next));
  }, []);

  useScrub(sectionRef, { disabled: mode !== 'pinned', onProgress: draw });
  useLayoutEffect(() => {
    if (mode === 'pinned' && svgRef.current) apply(svgRef.current, poseAt(lastS.current));
  }, [mode, hero]);

  const head = <ChapterHead id="run-title" label="The run" title="Every step leaves a number." />;
  const caption = hero ? sourceLine({ n: 3, run: hero.run_id, measured: hero.measured_at, extra: 'drawing not to scale' }) : 'drawing not to scale';
  const appliedCaption = example ? sourceLine({ n: 3, run: example.run_id, measured: example.measured_at, extra: 'drawing not to scale' }) : caption;

  if (mode !== 'pinned') {
    return (
      <section className="ch ch-flow" id="run" aria-labelledby="run-title">
        <div className="ch-inner">
          {head}
          {mode === 'pager' ? (
            <Pager label="The eight stages of a run" count={STAGES.length}>
              {STAGES.map((_, i) => (
                <div className="pager-page" key={i}>
                  <StageCard hero={hero} example={example} index={i} />
                </div>
              ))}
            </Pager>
          ) : (
            <div className="run-flat">
              {STAGES.map((_, i) => (
                <StageCard key={i} hero={hero} example={example} index={i} />
              ))}
            </div>
          )}
          <p className="t-caption">
            {caption}
            {example && ` · stages ${FIRST_APPLIED_STAGE + 1} to ${STAGES.length} from run ${example.run_id}`}
          </p>
        </div>
      </section>
    );
  }

  const current = STAGES[stage];
  return (
    <section className="ch ch-pin" id="run" aria-labelledby="run-title" ref={sectionRef} data-snap-steps={mode === 'pinned' ? STAGES.length : undefined} style={{ height: `${100 + STAGES.length * 45}vh` }}>
      <div className="ch-stage ch-stage-split">
        <div className="run-text">
          {head}
          <div className="run-sentence" key={stage}>
            <span className="t-label run-word">
              {pad(stage + 1)} / {pad(STAGES.length)} · {current.word}
            </span>
            <p className="t-display-m run-line">{current.line}</p>
          </div>
          <Segments count={STAGES.length} index={stage} />
        </div>
        <figure className="run-figure">
          <Frame className="run-tile">
            <Stack hero={hero} svgRef={svgRef} />
            <div className="run-values-box">{values(hero, example, stage)}</div>
          </Frame>
          <figcaption className="t-caption figure-caption">{stage >= FIRST_APPLIED_STAGE ? appliedCaption : caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}
