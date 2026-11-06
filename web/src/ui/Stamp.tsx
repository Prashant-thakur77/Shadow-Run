import type { ReactNode } from 'react';
import type { Tone } from '../lib/status';
import { Mark } from './bits';

/** A verdict that lands. Tone follows the rule for colour: good and bad only when a measurement says so. */
export function Stamp({ tone = 'neutral', land = false, children }: { tone?: Tone; land?: boolean; children: ReactNode }) {
  const look = tone === 'good' || tone === 'bad' || tone === 'caution' ? tone : tone === 'wait' ? 'caution' : 'neutral';
  return (
    <span className={`stamp stamp-${look}${land ? ' is-landing' : ''}`}>
      <Mark tone={tone} size={13} />
      <span>{children}</span>
    </span>
  );
}
