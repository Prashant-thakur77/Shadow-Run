import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { PublicHero } from '../../api/types';
import { num, short } from '../../lib/format';
import { Mark } from '../../ui/bits';
import { asInputs, layoutRooms, type Room, type RoomLayout } from '../../ui/dotfield';
import { sourceLine } from '../../ui/Figure';
import { Measured } from '../../ui/Measured';
import { cascadeOrder } from '../../ui/rehearsal';
import { useScrub } from '../../ui/useScrub';
import { ChapterHead, useMode, useSize } from './parts';

const clamp = (v: number) => Math.min(1, Math.max(0, v));

interface Via {
  from: string;
  to: string;
  onDelete: string;
  rows: number | null;
  d: string;
  door: { x: number; y: number; vertical: boolean };
  end: { x: number; y: number };
}

/** An orthogonal path from the middle of one room to the middle of another, and where it crosses the second room's wall. */
function route(a: Room, b: Room): Pick<Via, 'd' | 'door' | 'end'> {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const bx = b.x + b.w / 2;
  const by = b.y + b.h / 2;
  const inside = ax > b.x && ax < b.x + b.w;
  if (inside) {
    // Straight up or down into the room.
    const wall = ay > by ? b.y + b.h : b.y;
    return { d: `M${ax} ${ay}L${ax} ${by}`, door: { x: ax, y: wall, vertical: false }, end: { x: ax, y: by } };
  }
  const wall = ax < b.x ? b.x : b.x + b.w;
  return { d: `M${ax} ${ay}L${ax} ${by}L${bx} ${by}`, door: { x: wall, y: by, vertical: true }, end: { x: bx, y: by } };
}

function BlueprintPlan({ hero, layout, order, svgRef }: { hero: PublicHero; layout: RoomLayout; order: { table: string; depth: number }[]; svgRef: React.RefObject<SVGSVGElement> }) {
  const roomOf = (t: string) => layout.rooms.find((r) => r.table === t);
  const via: Via[] = hero.edges.flatMap((e) => {
    const a = roomOf(e.from);
    const b = roomOf(e.to);
    return a && b ? [{ from: e.from, to: e.to, onDelete: e.on_delete ?? '', rows: e.rows ?? null, ...route(a, b) }] : [];
  });
  const touched = new Map(hero.tables.map((t) => [t.table, t]));
  const damaged = (table: string) => {
    const t = touched.get(table);
    return !!t && (t.deleted ?? 0) === 0 && (t.updated ?? 0) > 0;
  };
  const via1 = (table: string) => via.find((v) => v.to === table);
  return (
    <svg ref={svgRef} className="bp-svg" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={`Floor plan of the database. Rooms are tables, and area follows row count. ${hero.tables.length} tables were changed.`}>
      <defs>
        <pattern id="bp-grid" width={layout.squarePx} height={layout.squarePx} patternUnits="userSpaceOnUse">
          <path className="bp-square" d={`M${layout.squarePx} 0H0V${layout.squarePx}`} fill="none" />
        </pattern>
        <pattern id="bp-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0V7" stroke="var(--bad)" strokeWidth="2.4" />
        </pattern>
      </defs>
      <rect className="bp-ground" x="0" y="0" width={layout.width} height={layout.height} />
      <rect x="0" y="0" width={layout.width} height={layout.height} fill="url(#bp-grid)" />
      {layout.rooms.map((r) => {
        const hit = touched.has(r.table);
        const depthIndex = order.findIndex((o) => o.table === r.table);
        return (
          <g key={r.table} data-room={r.table} className={`bp-room${hit ? ' is-hit' : ''}${r.tiny ? ' is-tiny' : ''}${damaged(r.table) ? ' is-damaged-room' : ''}`}>
            {hit && <rect className="bp-flood" data-flood={depthIndex} x={r.x} y={r.y} width={r.w} height={r.h} fill={damaged(r.table) ? 'url(#bp-hatch)' : 'var(--bad)'} />}
            <rect className="bp-wall" x={r.x} y={r.y} width={r.w} height={r.h} pathLength={1} />
            <text className={`bp-label${damaged(r.table) ? ' is-damaged' : ''}`} x={r.labelX} y={r.labelY}>
              <tspan className="bp-name">{r.table}</tspan>
              <tspan className="bp-rows" dx="6">
                {num(r.rows)}
              </tspan>
            </text>
            {hit && !r.tiny && via1(r.table) && (
              <text className="bp-via-note" x={r.labelX} y={r.labelY + 15}>
                <tspan x={r.labelX}>from {via1(r.table)!.from}</tspan>
                <tspan x={r.labelX} dy="14">
                  {via1(r.table)!.onDelete}
                </tspan>
              </text>
            )}
          </g>
        );
      })}
      {via.map((v) => (
        <g key={`${v.from}-${v.to}`}>
          {/* A door: a break in the wall, with its swing. Doors are foreign keys. */}
          <rect className="bp-door-gap" x={v.door.x - (v.door.vertical ? 2 : 7)} y={v.door.y - (v.door.vertical ? 7 : 2)} width={v.door.vertical ? 4 : 14} height={v.door.vertical ? 14 : 4} />
          <path
            className="bp-door"
            d={v.door.vertical ? `M${v.door.x} ${v.door.y - 7}a14 14 0 0 1 14 14` : `M${v.door.x - 7} ${v.door.y}a14 14 0 0 1 14 -14`}
          />
          <path className="bp-via" d={v.d} pathLength={1} />
          <rect className="bp-node" x={v.end.x - 3} y={v.end.y - 3} width="6" height="6" />
        </g>
      ))}
    </svg>
  );
}

export function Blueprint({ hero }: { hero: PublicHero | null }) {
  const mode = useMode();
  const sectionRef = useRef<HTMLElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const tallyRef = useRef<HTMLDivElement>(null);
  const size = useSize(boxRef);

  const order = useMemo(() => (hero ? cascadeOrder(hero) : []), [hero]);
  const layout = useMemo(() => {
    if (!hero) return null;
    const w = mode === 'pager' ? 720 : size.w;
    const h = mode === 'pager' ? 540 : mode === 'flat' ? Math.min(680, Math.round(w * 0.82)) : size.h;
    return w > 80 && h > 80 ? layoutRooms(asInputs(hero.snapshot_rows), w, h) : null;
  }, [hero, mode, size.w, size.h]);

  // Walls first, then the flood along the foreign keys, then the paths and the tally. Scroll-driven, so all linear.
  const draw = useCallback(
    (p: number) => {
      const svg = svgRef.current;
      if (!svg) return;
      // Half the walls are already up when the chapter arrives, so a visitor who jumps here never lands on a blank page.
      const walls = clamp(0.5 + (p / 0.3) * 0.5);
      const flood = clamp((p - 0.3) / 0.4);
      const paths = clamp((p - 0.7) / 0.25);
      svg.style.setProperty('--walls', walls.toFixed(3));
      const wallEls = svg.querySelectorAll<SVGRectElement>('.bp-wall');
      wallEls.forEach((el, i) => {
        const k = clamp(walls * (1 + wallEls.length * 0.12) - i * 0.12);
        el.style.strokeDashoffset = String(1 - k);
      });
      svg.querySelectorAll<SVGPathElement | SVGRectElement>('.bp-door, .bp-door-gap').forEach((el) => {
        el.style.opacity = walls >= 1 ? '1' : '0';
      });
      const n = Math.max(1, order.length);
      svg.querySelectorAll<SVGRectElement>('.bp-flood').forEach((el) => {
        const i = Number(el.dataset.flood);
        const k = clamp((flood - (i / n) * 0.72) / 0.28);
        el.style.transform = `scaleY(${k.toFixed(3)})`;
        el.parentElement?.classList.toggle('is-flooded', k > 0.55);
      });
      svg.querySelectorAll<SVGPathElement>('.bp-via').forEach((el) => {
        el.style.strokeDashoffset = String(1 - paths);
        el.style.opacity = paths > 0 ? '1' : '0';
      });
      svg.classList.toggle('show-via', paths > 0.5);
      svg.classList.toggle('show-nodes', paths >= 1);
      const rows = listRef.current?.children;
      if (rows) {
        for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('is-on', clamp((flood - (i / n) * 0.72) / 0.28) >= 1);
      }
      tallyRef.current?.classList.toggle('is-on', p >= 0.82);
    },
    [order],
  );

  useScrub(sectionRef, { disabled: mode !== 'pinned', onProgress: draw });
  // Flat and pager versions show the final state at once. A new layout also redraws at the current progress.
  useLayoutEffect(() => {
    if (!layout) return;
    const p = mode === 'pinned' ? Number(sectionRef.current?.style.getPropertyValue('--p') || 0) : 1;
    draw(p);
  }, [layout, mode, draw]);

  const head = <ChapterHead id="blueprint-title" label="The blueprint" title="The schema is the blast radius." lead="Rooms are tables and doors are foreign keys. Watch what one plan reached on the clone." />;

  if (!hero) {
    return (
      <section className="ch ch-flow" id="blueprint" aria-labelledby="blueprint-title">
        <div className="ch-inner">
          {head}
          <p className="ch-empty t-display-m">Not measured yet</p>
          <p className="ch-empty-note">The drawing is the real schema and a real rehearsal. Until one is stored, there's nothing to draw.</p>
        </div>
      </section>
    );
  }

  const tables = new Map(hero.tables.map((t) => [t.table, t]));
  const sentence = (table: string) => {
    const t = tables.get(table);
    if (!t) return null;
    const edge = hero.edges.find((e) => e.to === table);
    const deleted = t.deleted ?? 0;
    const updated = t.updated ?? 0;
    return {
      count: deleted > 0 ? `${num(deleted)} deleted` : `${num(updated)} updated`,
      via: edge ? `from ${edge.from}, ${edge.on_delete ?? ''}` : 'named in the plan',
      damaged: deleted === 0,
    };
  };
  const prodTone = hero.prod.unchanged === true ? 'good' : hero.prod.unchanged === false ? 'bad' : 'neutral';
  const prodLine = { good: "Prod's hash did not move", bad: "Prod's hash moved", neutral: "Prod's hash was not compared" }[prodTone];
  const caption = sourceLine({ n: 2, run: hero.run_id, measured: hero.measured_at, scale: layout ? `1 square = ${num(layout.squareRows)} rows` : null });

  const side = (
    <div className="bp-side">
      {head}
      <ol className="bp-list" ref={listRef}>
        {order.map((o) => {
          const s = sentence(o.table);
          return (
            s && (
              <li key={o.table} className="bp-row">
                <span className="bp-row-table">{o.table}</span>
                <span className={`bp-row-count${s.damaged ? ' is-damaged' : ''}`}>{s.count}</span>
                <span className="bp-row-via">{s.via}</span>
              </li>
            )
          );
        })}
      </ol>
      <div className="bp-tally" ref={tallyRef}>
        <dl className="bp-tally-cells">
          <div>
            <dt>Rows changed</dt>
            <dd className="t-num-m is-bad">
              <Measured value={hero.totals.rows_changed} format={num} />
            </dd>
          </div>
          <div>
            <dt>Via cascade</dt>
            <dd className="t-num-m">
              <Measured value={hero.totals.rows_via_cascade} format={num} />
            </dd>
          </div>
          <div>
            <dt>Tables</dt>
            <dd className="t-num-m">
              <Measured value={hero.totals.tables_touched} format={num} />
            </dd>
          </div>
        </dl>
        <p className="bp-tally-prod">
          <Mark tone={prodTone} size={13} /> {prodLine}: <code>{short(hero.prod.before, 12)}</code> before, <code>{short(hero.prod.after, 12)}</code> after.
        </p>
      </div>
    </div>
  );

  const plan = (
    <figure className="bp-figure">
      <div className={mode === 'pager' ? 'bp-box scroll-x' : 'bp-box'} ref={boxRef} tabIndex={mode === 'pager' ? 0 : undefined}>
        {layout && <BlueprintPlan hero={hero} layout={layout} order={order} svgRef={svgRef} />}
      </div>
      <figcaption className="t-caption figure-caption">{caption}</figcaption>
    </figure>
  );

  if (mode !== 'pinned') {
    return (
      <section className="ch ch-flow" id="blueprint" aria-labelledby="blueprint-title">
        <div className="ch-inner bp-flow">
          {plan}
          {side}
        </div>
      </section>
    );
  }

  return (
    <section className="ch ch-pin" id="blueprint" data-jump="end" aria-labelledby="blueprint-title" ref={sectionRef} style={{ height: '200vh' }}>
      <div className="ch-stage ch-stage-split">
        {plan}
        {side}
      </div>
    </section>
  );
}
