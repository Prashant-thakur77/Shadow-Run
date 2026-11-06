import type { Receipt } from '../api/types';
import { num, plural } from './format';

interface Count {
  rows: Receipt[];
  hit: number;
  total: number;
}

export interface ControlSplit {
  attacks: Count;
  honest: Count;
  /** "22 attacks refused, rolled back or held, and 11 checks that the honest path still works" */
  words: string;
}

function count(items: Receipt[], kind: string): Count {
  const rows = items.filter((r) => r.kind === kind);
  return { rows, hit: rows.filter((r) => r.value === 'pass').length, total: rows.length };
}

const howMany = ({ hit, total }: Count) => (hit === total ? num(total) : `${num(hit)} of ${num(total)}`);

/** The negative controls by what they test, counted from the receipts. Null if any row doesn't say, so the words can't undercount. */
export function controlSplit(items: Receipt[]): ControlSplit | null {
  const attacks = count(items, 'attack');
  const honest = count(items, 'honest path');
  if (!items.length || attacks.total + honest.total !== items.length) return null;
  const parts = [
    attacks.total > 0 && `${howMany(attacks)} ${plural(attacks.total, 'attack')} refused, rolled back or held`,
    honest.total > 0 && `${howMany(honest)} ${plural(honest.total, 'check')} that the honest path still works`,
  ].filter(Boolean);
  return { attacks, honest, words: parts.join(', and ') };
}
