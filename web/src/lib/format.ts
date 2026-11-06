export const MISSING = '–';

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function num(v: unknown): string {
  return isNum(v) ? v.toLocaleString('en-US') : MISSING;
}

export function ms(v: unknown): string {
  if (!isNum(v)) return MISSING;
  if (Math.abs(v) >= 100) return `${Math.round(v).toLocaleString('en-US')} ms`;
  return `${v.toFixed(1)} ms`;
}

export function usd(v: unknown): string {
  if (!isNum(v)) return MISSING;
  if (v === 0) return '$0';
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(6)}`;
}

export function pct(v: unknown): string {
  return isNum(v) ? `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}%` : MISSING;
}

export function bytes(v: unknown): string {
  if (!isNum(v)) return MISSING;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KiB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MiB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

const dateTime = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function when(t: unknown): string {
  return isNum(t) ? dateTime.format(new Date(t * 1000)) : MISSING;
}

export function clockTime(t: unknown): string {
  return isNum(t) ? clock.format(new Date(t * 1000)) : MISSING;
}

export function short(hash: unknown, chars = 12): string {
  if (typeof hash !== 'string' || !hash) return MISSING;
  return hash.length > chars ? `${hash.slice(0, chars)}…` : hash;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** Any stored value as plain text, never as markup. */
export function asText(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
