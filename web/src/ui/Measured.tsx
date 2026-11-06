import { useState, type ReactNode } from 'react';

/** Only the digits that differ move. The old one leaves upward and the new one enters from below, in a masked cell.
 *  Only the two real values are ever on screen: nothing counts up, rolls through, or tweens. */
function DigitSlots({ text }: { text: string }) {
  const [state, setState] = useState({ now: text, was: null as string | null, gen: 0 });
  // Derived state, set during render, so the old value is known in the same paint as the new one.
  if (state.now !== text) setState({ now: text, was: state.now, gen: state.gen + 1 });
  const { was, gen } = state;
  const now = state.now !== text ? text : state.now;
  const len = Math.max(now.length, was?.length ?? 0);
  const cells: ReactNode[] = [];
  for (let i = len - 1; i >= 0; i--) {
    // Counted from the right, so 5,234 and 17,234 line up on their shared digits.
    const char = now[now.length - 1 - i];
    const old = was?.[was.length - 1 - i];
    const changed = was !== null && old !== char;
    if (char === undefined && !changed) continue;
    cells.push(
      <span className="ms-cell" key={i} style={char === undefined ? { width: 0 } : undefined}>
        {changed && old !== undefined && (
          <span className="ms-old" key={`o${gen}`}>
            {old}
          </span>
        )}
        {char !== undefined && (
          <span className={changed ? 'ms-new' : 'ms-now'} key={changed ? `n${gen}` : 'n'}>
            {char}
          </span>
        )}
      </span>,
    );
  }
  return (
    <span className="ms-cells" aria-hidden="true" style={{ display: 'inline-flex' }}>
      {cells}
    </span>
  );
}

/** A number from the API. Null renders the words "Not measured", never a figure.
 *  `source` says where it came from, so the drawing can state it. */
export function Measured<T>({
  value,
  format,
  source,
  className = '',
  empty = 'Not measured',
}: {
  value: T | null | undefined;
  format?: (v: T) => string;
  source?: string;
  className?: string;
  empty?: string;
}) {
  if (value === null || value === undefined) {
    return <span className={`ms ms-empty ${className}`}>{empty}</span>;
  }
  const text = format ? format(value) : String(value);
  return (
    <span className={`ms ${className}`} title={source}>
      <span className="sr-only">{text}</span>
      <DigitSlots text={text} />
    </span>
  );
}
