import type { Metric, Report } from '../api/types';
import { money, num, signedMoney, signedNum } from '../lib/format';

export function hasMoved(m: Metric): boolean {
  return !!m.lost_entirely || (m.delta !== undefined && m.delta !== null ? m.delta !== 0 : m.before !== m.after);
}

export function metricValue(v: number | null | undefined, unit?: string): string {
  return unit === 'usd' ? money(v) : num(v);
}

export function metricDelta(m: Metric): string {
  if (m.lost_entirely) return m.unit === 'usd' ? money(-(m.before ?? 0)) : signedNum(-(m.before ?? 0));
  return m.unit === 'usd' ? signedMoney(m.delta) : signedNum(m.delta);
}

/** Dollars gone, measured. Null when the metric isn't money or didn't fall. */
export function dollarsLost(m: Metric): number | null {
  if (m.unit !== 'usd') return null;
  if (m.lost_entirely) return m.before ?? null;
  return typeof m.delta === 'number' && m.delta < 0 ? -m.delta : null;
}

/** The single largest measured loss. These metrics overlap, so they are never added together. */
export function biggestLoss(report?: Report | null): { metric: Metric; lost: number } | null {
  let best: { metric: Metric; lost: number } | null = null;
  for (const m of report?.metrics ?? []) {
    const lost = dollarsLost(m);
    if (lost !== null && lost > 0 && (!best || lost > best.lost)) best = { metric: m, lost };
  }
  return best;
}
