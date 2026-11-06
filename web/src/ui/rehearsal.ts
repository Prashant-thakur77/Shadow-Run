import type { Metric, PublicHero } from '../api/types';
import { money, num, short } from '../lib/format';
import { dollarsLost } from '../run/metrics';

/** Everything a replay shows, worked out once from the measurement. Times are milliseconds from the first event:
 *  offsets come from `timeline`, durations from `phases`, and nothing is stretched or eased. */

const MAX_MS = 6000;
const HEAT_MS = 180; // the red on a dying dot decays over this long
const CRT_X_MS = 120;
const SKIP_BEAT_MS = 180; // room to read the skip tick. Not a measured duration, and the tick says so.

export interface TableWindow {
  table: string;
  depth: number;
  start: number;
  end: number;
  rowsBefore: number;
  rowsAfter: number;
  deleted: number;
  updated: number;
  inserted: number;
  changed: number;
  /** Running sum of measured per-table counts when this table lands. */
  running: number;
}

export interface LedgerRow {
  id: string;
  at: number;
  label: string;
  value?: string;
  tone?: 'good' | 'bad';
  lock?: boolean;
  skip?: boolean;
  table?: boolean;
}

export interface Loss {
  name: string;
  lost: number;
  text: string;
}

export interface Script {
  factor: number;
  boot: [number, number];
  exec: [number, number];
  destroy: [number, number];
  crtEnd: number;
  guardrailsAt: number;
  skipAt: number;
  prodAt: number;
  end: number;
  heatMs: number;
  windows: TableWindow[];
  ledger: LedgerRow[];
  cues: number[];
  rowsChanged: number | null;
  loss: Loss | null;
  others: { name: string; text: string }[];
  guardrailsFailed: number;
  /** A measurement found harm: a failed guardrail or money lost. Without one, a plan's changes are drawn in neutral. */
  harmful: boolean;
  skipSeconds: number | null;
  /** Stops for the reduced-motion stepper: each one is the end of a phase. */
  stops: { at: number; label: string }[];
}

/** Table names the plan mentions, which is where the cascade starts. */
export function tablesInPlan(command: string[]): string[] {
  const found: string[] = [];
  for (const cmd of command) {
    for (const m of cmd.matchAll(/\b(?:FROM|UPDATE|TRUNCATE(?:\s+TABLE)?|INTO|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(?:ONLY\s+)?"?([a-zA-Z_][\w]*)"?/gi)) {
      if (!found.includes(m[1])) found.push(m[1]);
    }
  }
  return found;
}

/** Breadth-first down the foreign keys, starting at the tables the plan names. */
export function cascadeOrder(hero: Pick<PublicHero, 'tables' | 'edges' | 'command'>): { table: string; depth: number }[] {
  const touched = new Set(hero.tables.map((t) => t.table));
  const named = tablesInPlan(hero.command).filter((t) => touched.has(t));
  const roots = named.length ? named : hero.tables.filter((t) => !t.cascade).map((t) => t.table);
  const seen = new Set<string>();
  const out: { table: string; depth: number }[] = [];
  let level = roots;
  let depth = 0;
  while (level.length) {
    const next: string[] = [];
    for (const table of level) {
      if (seen.has(table) || !touched.has(table)) continue;
      seen.add(table);
      out.push({ table, depth });
      for (const e of hero.edges) if (e.from === table && !seen.has(e.to)) next.push(e.to);
    }
    level = next;
    depth++;
  }
  // Anything the graph doesn't explain still happened, so it lands last.
  for (const t of hero.tables) if (!seen.has(t.table)) out.push({ table: t.table, depth });
  return out;
}

function asMetric(m: PublicHero['metrics'][number]): Metric {
  return { ...m, delta: typeof m.before === 'number' && typeof m.after === 'number' ? m.after - m.before : undefined } as Metric;
}

/** The largest measured loss and the next two, from the metrics as the run recorded them. */
export function lossesOf(metrics: PublicHero['metrics']): { loss: Loss | null; others: { name: string; text: string }[] } {
  const moved = metrics
    .map((m) => ({ m, lost: dollarsLost(asMetric(m)) }))
    .filter((x) => x.lost !== null && x.lost > 0)
    .sort((a, b) => (b.lost as number) - (a.lost as number));
  const first = moved[0];
  const loss = first ? { name: first.m.name ?? 'Measured loss', lost: first.lost as number, text: money(-(first.lost as number)) } : null;
  const others = moved.slice(1, 3).map((x) => ({ name: x.m.name ?? '', text: money(-(x.lost as number)) }));
  if (others.length < 2) {
    for (const m of metrics) {
      if (others.length >= 2) break;
      if (m.unit === 'usd' || typeof m.before !== 'number' || typeof m.after !== 'number' || m.before === m.after) continue;
      others.push({ name: m.name ?? '', text: `${num(m.before)} to ${num(m.after)}` });
    }
  }
  return { loss, others };
}

export function buildScript(hero: PublicHero): Script {
  const at = (type: string) => {
    const e = hero.timeline.find((x) => x.type === type);
    return e ? e.t * 1000 : null;
  };
  const p = hero.phases;
  const total = p.total_ms ?? 0;
  const factor = total > MAX_MS ? total / MAX_MS : 1;
  const scale = (ms: number) => ms / factor;

  const r0 = scale(at('rehearsal_started') ?? 0);
  // A Linux host boots systemd and loads its state as part of coming up.
  const measuredBoot = (p.clone_boot_ms ?? 0) + (p.systemd_boot_ms ?? 0) + (p.load_state_ms ?? 0);
  const bootMs = scale(measuredBoot);
  const firstMs = scale(p.first_exec_ms ?? 0);
  const probeMs = scale(p.probe_ms ?? 0);
  const execMs = scale(p.execute_ms ?? 0);
  const scanMs = scale(p.secret_scan_ms ?? 0);
  const destroyMs = scale(p.destroy_ms ?? 0);

  const bootEnd = r0 + bootMs;
  const probeStart = bootEnd + firstMs;
  const execStart = probeStart + probeMs;
  const execEnd = execStart + execMs;
  const scanEnd = execEnd + scanMs;
  const destroyEnd = scanEnd + destroyMs;
  const crtEnd = destroyEnd + CRT_X_MS;
  const guardrailsAt = Math.max(destroyEnd, scale(at('guardrails_checked') ?? destroyEnd));
  const skipAt = Math.max(guardrailsAt, crtEnd);
  const prodAt = skipAt + SKIP_BEAT_MS;
  const end = prodAt + 1;

  // Tables die in breadth-first order, in windows that overlap across the measured execute phase.
  const order = cascadeOrder(hero);
  const n = order.length;
  const span = n > 1 ? execMs * (0.8 / n) * (n - 1) : 0;
  const width = execMs - span;
  let running = 0;
  const windows: TableWindow[] = order.map(({ table, depth }, i) => {
    const t = hero.tables.find((x) => x.table === table)!;
    const deleted = t.deleted ?? 0;
    const updated = t.updated ?? 0;
    const inserted = t.inserted ?? 0;
    running += deleted + updated + inserted;
    const start = execStart + (n > 1 ? (span * i) / (n - 1) : 0);
    return { table, depth, start, end: start + width, rowsBefore: t.rows_before ?? 0, rowsAfter: t.rows_after ?? 0, deleted, updated, inserted, changed: deleted + updated + inserted, running };
  });

  const { loss, others } = lossesOf(hero.metrics);
  const failed = hero.guardrails.total - hero.guardrails.passed;
  const harmful = failed > 0 || loss !== null;

  const ledger: LedgerRow[] = [];
  const add = (row: LedgerRow) => ledger.push(row);
  const offset = (ms: number | null) => (ms === null ? undefined : `+${Math.round(ms).toLocaleString('en-US')} ms`);
  const snapshotAt = at('snapshot_taken');
  if (snapshotAt !== null) add({ id: 'snapshot', at: scale(snapshotAt), label: 'snapshot', value: offset(snapshotAt) });
  const frozenAt = at('plan_frozen');
  if (frozenAt !== null) add({ id: 'plan', at: scale(frozenAt), label: 'plan', value: short(hero.plan_hash, 12).replace('…', ''), lock: true });
  const gateAt = at('static_gate');
  if (gateAt !== null) add({ id: 'gate', at: scale(gateAt), label: 'static gate', value: offset(gateAt) });
  add({ id: 'boot', at: bootEnd, label: 'boot', value: msText(measuredBoot || null) });
  hero.probes.forEach((probe, i) => {
    const blocked = probe.result === 'BLOCKED';
    add({
      id: `probe-${i}`,
      at: probeStart + (probeMs * (i + 1)) / Math.max(1, hero.probes.length),
      label: probe.label ?? 'probe',
      value: probe.result ?? undefined,
      tone: blocked ? 'good' : 'bad',
    });
  });
  for (const w of windows) add({ id: `t-${w.table}`, at: w.end, label: w.table, value: num(w.changed), tone: harmful ? 'bad' : undefined, table: true });
  add({ id: 'exec', at: execEnd + 0.01, label: 'execute', value: msText(p.execute_ms) });
  if (typeof hero.secret_scan.scanned === 'number' && typeof hero.secret_scan.hits === 'number') {
    add({ id: 'scan', at: scanEnd, label: 'secrets', value: `${num(hero.secret_scan.scanned)}, ${num(hero.secret_scan.hits)} hits`, tone: hero.secret_scan.hits === 0 ? 'good' : 'bad' });
  }
  add({ id: 'destroy', at: destroyEnd, label: 'destroyed', value: msText(p.destroy_ms) });
  add({ id: 'guardrails', at: guardrailsAt, label: 'guardrails', value: `${hero.guardrails.passed} of ${hero.guardrails.total}`, tone: failed > 0 ? 'bad' : hero.guardrails.total > 0 ? 'good' : undefined });

  const realGuard = at('guardrails_checked');
  const realProd = at('prod_checked');
  const skipSeconds = realGuard !== null && realProd !== null && realProd - realGuard > 400 ? (realProd - realGuard) / 1000 : null;
  if (skipSeconds !== null) add({ id: 'skip', at: skipAt, label: 'skip', value: `${skipSeconds.toFixed(1)} s`, skip: true });
  ledger.sort((a, b) => a.at - b.at);

  const cues = [...new Set([...ledger.map((r) => r.at), ...windows.map((w) => w.end), execEnd, destroyEnd, crtEnd, guardrailsAt, skipAt, prodAt])].sort((a, b) => a - b);

  const stops = [
    { at: Math.max(0, r0), label: 'frozen and gated' },
    { at: bootEnd, label: 'clone boots' },
    { at: execStart, label: 'probes blocked' },
    { at: execEnd, label: 'plan executes' },
    { at: scanEnd, label: 'secret scan' },
    { at: crtEnd, label: 'clone destroyed' },
    { at: skipAt, label: 'guardrails checked' },
    { at: end, label: 'prod checked' },
  ];

  return {
    factor,
    boot: [r0, bootEnd],
    exec: [execStart, execEnd],
    destroy: [scanEnd, destroyEnd],
    crtEnd,
    guardrailsAt,
    skipAt,
    prodAt,
    end,
    heatMs: HEAT_MS,
    windows,
    ledger,
    cues,
    rowsChanged: hero.totals.rows_changed ?? null,
    loss,
    others,
    guardrailsFailed: failed,
    harmful,
    skipSeconds,
    stops,
  };
}

function msText(v: number | null | undefined): string | undefined {
  return typeof v === 'number' ? `${Math.round(v).toLocaleString('en-US')} ms` : undefined;
}

/** Seeded, so a replay of a run always dissolves the same way. */
export function seededOrder(name: string, n: number): Uint32Array {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  let s = h >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** What the teardown checks measured, in words. Anything off is said plainly. */
export function teardownWords(t: PublicHero['teardown']): { text: string; clean: boolean } {
  const parts = [
    t.sandbox_listed === false ? 'not listed' : t.sandbox_listed === true ? 'still listed' : 'listing not checked',
    t.rootfs_exists === false ? 'disk gone' : t.rootfs_exists === true ? 'disk still there' : 'disk not checked',
    typeof t.leftover_processes === 'number' ? `${num(t.leftover_processes)} processes` : 'processes not checked',
  ];
  return { text: parts.join(' · '), clean: t.sandbox_listed === false && t.rootfs_exists === false && t.leftover_processes === 0 };
}
