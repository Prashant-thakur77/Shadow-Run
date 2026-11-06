import type { Target } from '../api/types';

// Which target the prod indicator measures. Pages set it from the run or target they are showing.
export const DEFAULT_TARGET = 'demo-saas';

let current = DEFAULT_TARGET;

export function currentTarget(): string {
  return current;
}

export function showTarget(id: string | undefined | null) {
  const next = id || DEFAULT_TARGET;
  if (next === current) return;
  current = next;
  window.dispatchEvent(new Event('sr:prod-changed'));
}

/** Databases first, because the demo starts there. */
export function orderTargets(list: Target[]): Target[] {
  return [...list].sort((a, b) => Number(a.kind === 'host') - Number(b.kind === 'host'));
}

export function targetLabel(t: Target): string {
  if (t.kind === 'host') return 'Linux server';
  if (t.kind === 'postgres') return 'Database';
  return t.name ?? t.id;
}
