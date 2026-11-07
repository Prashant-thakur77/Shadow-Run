import type { ReactNode } from 'react';

/** The instrument label: `[ THE BLAST ]`. The spaces inside the brackets don't break, so a wrapped label never strands a bracket. */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`bracket t-label ${className}`}>
      <span aria-hidden="true">[ </span>
      {children}
      <span aria-hidden="true"> ]</span>
    </span>
  );
}
