import type { HTMLAttributes, ReactNode } from 'react';
import { when } from '../lib/format';

/** "control plane" is what the record calls the server that runs Shadow Run. */
export function plainSource(from?: string | null): string {
  return `by Shadow Run's own server${from && /outside the sandbox/i.test(from) ? ', outside the sandbox' : ''}`;
}

/** A NIC is a network card, and the record's own word for it means nothing to most readers. */
export const plainNetwork = (policy: string) => policy.replace(/\bno NIC\b/gi, 'no network card');

/** The source line every drawing carries: `fig. 2 · run r56… · measured 6 Nov 11:38 · 1 dot = 25 rows`. */
export function sourceLine(parts: { n?: number; run?: string | null; measured?: number | null; scale?: string | null; extra?: string | null }): string {
  return [
    parts.n !== undefined ? `fig. ${parts.n}` : null,
    parts.run ? `run ${parts.run}` : null,
    parts.measured !== undefined && parts.measured !== null ? `measured ${when(parts.measured)}` : null,
    parts.scale,
    parts.extra,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function Caption({ children, className = '', ...rest }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return (
    <figcaption className={`t-caption figure-caption ${className}`} {...rest}>
      {children}
    </figcaption>
  );
}

export function Figure({
  n,
  run,
  measured,
  scale,
  extra,
  caption,
  className = '',
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  n?: number;
  run?: string | null;
  measured?: number | null;
  scale?: string | null;
  extra?: string | null;
  /** Anything beyond the standard source line. */
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <figure className={className} {...rest}>
      {children}
      <Caption>
        {sourceLine({ n, run, measured, scale, extra })}
        {caption}
      </Caption>
    </figure>
  );
}
