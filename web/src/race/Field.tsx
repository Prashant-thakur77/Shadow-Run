import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Report } from '../api/types';
import { num } from '../lib/format';
import { cssVar, matches, onThemeChange, PHONE, REDUCED } from '../lib/media';
import { asInputs, layoutDots, type DotLayout } from '../ui/dotfield';
import { seededOrder } from '../ui/rehearsal';

const LAND_MS = 480;
const LIT = 0;
const DELETED = 1;
const CHANGED = 2;

/** Which dots a report touches: its share of each table's rows, on the same seeded scatter the rest of the app uses. */
function fateOf(layout: DotLayout, report: Report | null): Uint8Array {
  const fate = new Uint8Array(layout.total);
  for (const block of layout.blocks) {
    const t = report?.tables?.find((x) => x.table === block.table);
    if (!t || !block.dots) continue;
    const before = Math.max(1, t.rows_before ?? block.rows);
    const deleted = t.deleted ?? 0;
    const updated = Math.min(t.updated ?? 0, Math.max(0, before - deleted));
    const gone = Math.min(block.dots, deleted > 0 ? Math.max(1, Math.round((deleted / before) * block.dots)) : 0);
    const changed = Math.min(block.dots - gone, updated > 0 ? Math.max(1, Math.round((updated / before) * block.dots)) : 0);
    const order = seededOrder(block.table, block.dots);
    for (let k = 0; k < gone + changed; k++) fate[block.first + order[k]] = k < gone ? DELETED : CHANGED;
  }
  return fate;
}

function labelFor(rows: number, report: Report | null, table: string): { text: string; moved: boolean } {
  const t = report?.tables?.find((x) => x.table === table);
  if (!t) return { text: num(rows), moved: false };
  if (t.dropped) return { text: 'dropped', moved: true };
  if (t.deleted) return { text: `−${num(t.deleted)}`, moved: true };
  if (t.updated) return { text: `${num(t.updated)} upd`, moved: true };
  if (t.inserted) return { text: `+${num(t.inserted)}`, moved: false };
  return { text: num(rows), moved: false };
}

/** One database drawn as tables, the same way twice. A lane's measured report marks the rows it touched: filled for
 *  deleted, a ring for changed. Red only when that plan broke a guardrail, because colour arrives with evidence. */
export function RaceField({ rows, report, harmful, onScale }: { rows: Record<string, number> | null; report: Report | null; harmful: boolean; onScale?: (rowsPerDot: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [layout, setLayout] = useState<DotLayout | null>(null);
  const shown = useRef<Uint8Array | null>(null);
  const [tick, setTick] = useState(0);

  const tables = useMemo(
    // The label may grow to a figure such as "5,175 del", so the layout keeps room for four more characters.
    () => asInputs(rows ?? {}).map((t) => ({ ...t, widest: t.rows * 10000 })),
    [rows],
  );
  const key = tables.map((t) => `${t.table}:${t.rows}`).join('|');
  const layoutFor = useRef('');

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setLayout((prev) => {
        if (prev && prev.width === w && prev.height === h && layoutFor.current === key) return prev;
        layoutFor.current = key;
        const usual = matches(PHONE) ? { minScale: 25, minPitch: 3, maxPitch: 5 } : { minScale: 10, minPitch: 4, maxPitch: 8 };
        // Too tight for the usual dots: finer ones, rather than an empty box.
        return layoutDots(tables, w, h, usual) ?? layoutDots(tables, w, h, { minScale: 25, minPitch: 3, maxPitch: 4 });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (layout) onScale?.(layout.rowsPerDot);
  }, [layout, onScale]);

  const paint = (state: Uint8Array, l: DotLayout) => {
    const el = canvas.current;
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(l.width * dpr);
    const h = Math.round(l.height * dpr);
    if (el.width !== w || el.height !== h) {
      el.width = w;
      el.height = h;
    }
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const size = Math.max(1, Math.round(l.dot * dpr));
    ctx.clearRect(0, 0, el.width, el.height);
    const fill = (color: string, kind: number) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let i = 0; i < l.total; i++) if (state[i] === kind) ctx.rect(Math.round(l.x[i] * dpr), Math.round(l.y[i] * dpr), size, size);
      ctx.fill();
    };
    fill(cssVar('--dot-idle'), LIT);
    fill(harmful ? cssVar('--bad') : cssVar('--line'), DELETED);
    ctx.strokeStyle = harmful ? cssVar('--bad') : cssVar('--ink');
    ctx.lineWidth = Math.max(1, Math.round(dpr));
    ctx.beginPath();
    const inset = ctx.lineWidth / 2;
    for (let i = 0; i < l.total; i++) if (state[i] === CHANGED) ctx.rect(Math.round(l.x[i] * dpr) + inset, Math.round(l.y[i] * dpr) + inset, size - ctx.lineWidth, size - ctx.lineWidth);
    ctx.stroke();
  };

  // A new measurement lands once, in a fixed order. Nothing moves between measurements.
  const target = useMemo(() => (layout ? fateOf(layout, report) : null), [layout, report]);
  useEffect(() => {
    if (!layout || !target) return;
    const was = shown.current?.length === target.length ? shown.current : null;
    if (!was || matches(REDUCED)) {
      shown.current = target.slice();
      paint(target, layout);
      return;
    }
    const changing: number[] = [];
    for (let i = 0; i < target.length; i++) if (was[i] !== target[i]) changing.push(i);
    if (!changing.length) {
      paint(was, layout);
      return;
    }
    const order = seededOrder('race', changing.length);
    const state = was.slice();
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const upTo = Math.min(changing.length, Math.ceil(((now - start) / LAND_MS) * changing.length));
      for (let k = 0; k < upTo; k++) state[changing[order[k]]] = target[changing[order[k]]];
      shown.current = state;
      paint(state, layout);
      if (upTo < changing.length) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      // Interrupted by a newer measurement or a resize: the end state, so nothing is left half drawn.
      shown.current = target.slice();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, target, harmful, tick]);

  useEffect(() => onThemeChange(() => setTick((t) => t + 1)), []);

  return (
    <div className="rf" ref={box} aria-hidden="true">
      {!layout && tables.length > 0 && <p className="rf-undrawn">Too many tables to draw at this size. The numbers are below.</p>}
      <canvas ref={canvas} className="rf-canvas" style={layout ? { width: layout.width, height: layout.height } : undefined} />
      {layout?.blocks.map((b) => {
        const l = labelFor(b.rows, report, b.table);
        return (
          <span key={b.table} className={`rf-label${b.lines > 1 ? ' is-two-line' : ''}${l.moved && harmful ? ' is-bad' : ''}${l.moved && !harmful ? ' is-moved' : ''}`} style={{ left: b.x, top: b.y, width: b.w }}>
            <span className="rf-label-name">{b.table}</span>
            <span className="rf-label-rows">{l.text}</span>
          </span>
        );
      })}
    </div>
  );
}
