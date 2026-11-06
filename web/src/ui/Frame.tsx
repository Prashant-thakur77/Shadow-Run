import type { HTMLAttributes, ReactNode } from 'react';

/** A hairline with drafting ticks at its corners. */
export function Frame({ ticks = true, className = '', children, ...rest }: HTMLAttributes<HTMLDivElement> & { ticks?: boolean; children?: ReactNode }) {
  return (
    <div className={`frame ${className}`} {...rest}>
      {ticks && (
        <>
          <i className="frame-tick tl" aria-hidden="true" />
          <i className="frame-tick tr" aria-hidden="true" />
          <i className="frame-tick bl" aria-hidden="true" />
          <i className="frame-tick br" aria-hidden="true" />
        </>
      )}
      {children}
    </div>
  );
}
