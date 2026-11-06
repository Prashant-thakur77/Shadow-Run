/** The one layout for a database drawn as tables. The hero's panes, the run panel and the blueprint all use it, so
 *  a table sits in the same place in every drawing. Big tables get a treemap cell, and tiny ones go in a strip below. */

export interface TableInput {
  table: string;
  rows: number;
  /** The widest figure its label will ever show, if that's more than `rows`, so room is kept for it from the start. */
  widest?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Block extends Rect {
  table: string;
  rows: number;
  dots: number;
  tiny: boolean;
  /** 2 when the label is too wide for one line, with the count under the name. */
  lines: number;
  /** Where its grid of dots starts, and how many fit across. */
  dotX: number;
  dotY: number;
  cols: number;
  /** Index of its first dot in the layout's arrays. */
  first: number;
}

export interface DotLayout {
  width: number;
  height: number;
  pitch: number;
  dot: number;
  rowsPerDot: number;
  total: number;
  blocks: Block[];
  x: Float32Array;
  y: Float32Array;
}

export interface Room extends Rect {
  table: string;
  rows: number;
  tiny: boolean;
  /** Label position, which for a tiny room is above it. */
  labelX: number;
  labelY: number;
}

export interface RoomLayout {
  width: number;
  height: number;
  rooms: Room[];
  /** Rows per square pixel, the same for every room. */
  density: number;
  /** One grid square stands for this many rows, and is this many pixels across. */
  squareRows: number;
  squarePx: number;
}

const SCALES = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MAX_DOTS = 10000;
const LABEL_H = 15;
const GUTTER = 10;
const CHAR_W = 6.6; // Geist Mono at 11 px
const TINY_SHARE = 0.012;

// The treemap is cut in a fixed proportion and then stretched, so its arrangement doesn't change with the box.
const REF_W = 1.3;
const REF_H = 1;

function labelWidth(t: TableInput): number {
  return (t.table.length + 1 + Math.max(t.rows, t.widest ?? 0).toLocaleString('en-US').length) * CHAR_W + 2;
}

function nameWidth(t: TableInput): number {
  return t.table.length * CHAR_W + 2;
}

/** First-fit decreasing, so tiny tables take as few shelves as they can. */
function packShelves<T extends { w: number }>(items: T[], W: number): (T & { x: number })[][] {
  const shelves: { used: number; items: (T & { x: number })[] }[] = [];
  for (const item of [...items].sort((a, b) => b.w - a.w)) {
    const shelf = shelves.find((s) => s.used + item.w <= W);
    if (shelf) {
      shelf.items.push({ ...item, x: shelf.used });
      shelf.used += item.w + GUTTER;
    } else {
      shelves.push({ used: item.w + GUTTER, items: [{ ...item, x: 0 }] });
    }
  }
  return shelves.map((s) => s.items);
}

function worst(row: number[], sum: number, side: number): number {
  const max = Math.max(...row);
  const min = Math.min(...row);
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/** Squarified treemap: Bruls, Huizing and van Wijk, 2000. */
function squarify(weights: number[], box: Rect): Rect[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const areas = weights.map((w) => (w / total) * box.w * box.h);
  const rects: Rect[] = [];
  let { x, y, w, h } = box;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row: number[] = [];
    let sum = 0;
    let best = Infinity;
    let j = i;
    while (j < areas.length) {
      const next = worst([...row, areas[j]], sum + areas[j], side);
      if (row.length && next > best) break;
      row.push(areas[j]);
      sum += areas[j];
      best = next;
      j++;
    }
    if (w >= h) {
      const stripW = sum / h;
      let cy = y;
      for (const a of row) {
        const ch = a / stripW;
        rects.push({ x, y: cy, w: stripW, h: ch });
        cy += ch;
      }
      x += stripW;
      w -= stripW;
    } else {
      const stripH = sum / w;
      let cx = x;
      for (const a of row) {
        const cw = a / stripH;
        rects.push({ x: cx, y, w: cw, h: stripH });
        cx += cw;
      }
      y += stripH;
      h -= stripH;
    }
    i = j;
  }
  return rects;
}

function cells(weights: number[], W: number, H: number): Rect[] {
  return squarify(weights, { x: 0, y: 0, w: REF_W, h: REF_H }).map((r) => ({
    x: (r.x / REF_W) * W,
    y: (r.y / REF_H) * H,
    w: (r.w / REF_W) * W,
    h: (r.h / REF_H) * H,
  }));
}

function byRows(a: TableInput, b: TableInput) {
  return b.rows - a.rows || a.table.localeCompare(b.table);
}

export function asInputs(rows: Record<string, number | null | undefined>): TableInput[] {
  return Object.entries(rows)
    .map(([table, n]) => ({ table, rows: typeof n === 'number' ? n : 0 }))
    .sort(byRows);
}

function tryDots(tables: TableInput[], W: number, H: number, scale: number, pitch: number): DotLayout | null {
  const total = tables.reduce((a, t) => a + t.rows, 0) || 1;
  const dotsOf = (t: TableInput) => (t.rows > 0 ? Math.max(1, Math.round(t.rows / scale)) : 0);
  const dot = Math.max(2, Math.round(pitch * 0.62));
  let tiny = tables.filter((t) => t.rows / total < TINY_SHARE);
  let main = tables.filter((t) => !tiny.includes(t));
  const twoLine = new Set<string>();

  for (let guard = 0; guard <= tables.length * 2 + 2; guard++) {
    // Tiny tables, on shelves along the bottom.
    const prepared = tiny.map((t) => {
      const n = dotsOf(t);
      const lw = labelWidth(t);
      const across = Math.max(1, Math.floor(lw / pitch), Math.ceil(Math.sqrt(n * 2.5)));
      return { item: t, cols: across, rowsOf: Math.ceil(n / across), w: Math.max(lw, across * pitch) };
    });
    if (prepared.some((p) => p.w > W)) return null;
    const shelves = packShelves(prepared, W);
    const shelfHeights = shelves.map((s) => LABEL_H + Math.max(...s.map((i) => i.rowsOf)) * pitch);
    const stripH = shelfHeights.reduce((a, b) => a + b + GUTTER, 0);
    const mainH = H - stripH;
    if (mainH < (main.length ? 48 : 0)) return null;

    // Main tables. A cell's weight includes its label line, so slack is shared out evenly.
    const labelH = (t: TableInput) => LABEL_H * (twoLine.has(t.table) ? 2 : 1);
    const weights = main.map((t) => dotsOf(t) * pitch * pitch * 1.06 + (labelH(t) + GUTTER) * 90);
    const rects = main.length ? cells(weights, W, mainH) : [];
    // A table leaves the treemap only if its name can't fit. A label that's merely long takes two lines.
    const narrow = main.find((t, i) => nameWidth(t) > rects[i].w - GUTTER);
    if (narrow) {
      tiny = [...tiny, narrow].sort(byRows);
      main = main.filter((t) => t !== narrow);
      continue;
    }
    const wrap = main.find((t, i) => !twoLine.has(t.table) && labelWidth(t) > rects[i].w - GUTTER);
    if (wrap) {
      twoLine.add(wrap.table);
      continue;
    }

    const blocks: Block[] = [];
    let first = 0;
    let fits = true;
    main.forEach((t, i) => {
      const r = rects[i];
      const n = dotsOf(t);
      const cols = Math.max(1, Math.floor((r.w - GUTTER + (pitch - dot)) / pitch));
      if (Math.ceil(n / cols) * pitch > r.h - labelH(t) - GUTTER + (pitch - dot)) fits = false;
      blocks.push({ table: t.table, rows: t.rows, dots: n, tiny: false, lines: twoLine.has(t.table) ? 2 : 1, x: r.x, y: r.y, w: r.w - GUTTER, h: r.h - GUTTER, dotX: r.x, dotY: r.y + labelH(t), cols, first });
      first += n;
    });
    if (!fits) return null;

    let shelfY = mainH;
    shelves.forEach((s, si) => {
      for (const i of s) {
        const n = dotsOf(i.item);
        blocks.push({ table: i.item.table, rows: i.item.rows, dots: n, tiny: true, lines: 1, x: i.x, y: shelfY, w: i.w, h: shelfHeights[si], dotX: i.x, dotY: shelfY + LABEL_H, cols: i.cols, first });
        first += n;
      }
      shelfY += shelfHeights[si] + GUTTER;
    });

    const x = new Float32Array(first);
    const y = new Float32Array(first);
    for (const b of blocks) {
      for (let k = 0; k < b.dots; k++) {
        x[b.first + k] = Math.round(b.dotX) + (k % b.cols) * pitch;
        y[b.first + k] = Math.round(b.dotY) + Math.floor(k / b.cols) * pitch;
      }
    }
    return { width: W, height: H, pitch, dot, rowsPerDot: scale, total: first, blocks, x, y };
  }
  return null;
}

/** The smallest rows-per-dot that fits, then the largest pitch at that scale. */
export function layoutDots(tables: TableInput[], W: number, H: number, opts: { minScale?: number; minPitch?: number; maxPitch?: number } = {}): DotLayout | null {
  const { minScale = 5, minPitch = 5, maxPitch = 8 } = opts;
  if (W < 40 || H < 40) return null;
  const rows = tables.reduce((a, t) => a + t.rows, 0);
  for (const scale of SCALES) {
    // On a very large screen the smallest scale could mean tens of thousands of dots, and the frame budget comes first.
    if (scale < minScale || rows / scale > MAX_DOTS) continue;
    for (let pitch = maxPitch; pitch >= minPitch; pitch--) {
      const result = tryDots(tables, W, H, scale, pitch);
      if (result) return result;
    }
  }
  return null;
}

/** The same tables as rooms of a floor plan, whose area follows row count on one stated scale. */
export function layoutRooms(tables: TableInput[], W: number, H: number): RoomLayout {
  const total = tables.reduce((a, t) => a + t.rows, 0) || 1;
  let tiny = tables.filter((t) => t.rows / total < TINY_SHARE);
  let main = tables.filter((t) => !tiny.includes(t));

  for (let guard = 0; guard <= tables.length; guard++) {
    // A first pass at the density sets how tall the strip must be. Rooms are 1.6 times as wide as they are tall.
    const roughDensity = Math.max(1e-6, (main.length ? main.reduce((a, t) => a + t.rows, 0) : total) / (W * H * 0.86));
    const placed: { t: TableInput; w: number; h: number; x: number; shelf: number; cell: number }[] = [];
    const shelfTall: number[] = [];
    let cursor = 0;
    let shelfIndex = 0;
    for (const t of tiny) {
      const area = t.rows / roughDensity;
      const rh = Math.sqrt(area / 1.6);
      const rw = rh * 1.6;
      const cell = Math.max(labelWidth(t), rw);
      if (cursor + cell > W && cursor > 0) {
        shelfIndex++;
        cursor = 0;
      }
      placed.push({ t, w: rw, h: rh, x: cursor, shelf: shelfIndex, cell });
      shelfTall[shelfIndex] = Math.max(shelfTall[shelfIndex] ?? 0, LABEL_H + rh + 6);
      cursor += cell + GUTTER + 4;
    }
    const stripH = shelfTall.reduce((a, b) => a + b + GUTTER, 0);
    const mainH = Math.max(H * 0.4, H - stripH);
    const rects = main.length ? cells(main.map((t) => t.rows), W, mainH) : [];
    const narrow = main.find((t, i) => labelWidth(t) > rects[i].w - 8);
    // The biggest table always stays in the plan, so there's a plan left to draw.
    if (narrow && main.length > 1) {
      tiny = [...tiny, narrow].sort(byRows);
      main = main.filter((t) => t !== narrow);
      continue;
    }
    const density = Math.max(1e-6, main.reduce((a, t) => a + t.rows, 0) / (W * mainH) || roughDensity);
    const rooms: Room[] = main.map((t, i) => ({ table: t.table, rows: t.rows, tiny: false, ...rects[i], labelX: rects[i].x + 8, labelY: rects[i].y + 16 }));
    let y = mainH + GUTTER;
    shelfTall.forEach((tall, si) => {
      for (const p of placed.filter((q) => q.shelf === si)) {
        rooms.push({ table: p.t.table, rows: p.t.rows, tiny: true, x: p.x, y: y + LABEL_H, w: Math.max(p.w, 1), h: Math.max(p.h, 1), labelX: p.x, labelY: y + 10 });
      }
      y += tall + GUTTER;
    });
    const nice = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000].find((n) => Math.sqrt(n / density) >= 16) ?? 10000;
    return { width: W, height: H, rooms, density, squareRows: nice, squarePx: Math.sqrt(nice / density) };
  }
  return { width: W, height: H, rooms: [], density: 1, squareRows: 100, squarePx: 20 };
}
