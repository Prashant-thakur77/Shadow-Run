import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import type { Tone } from '../lib/status';
import { short } from '../lib/format';

/** Status shape. Tone is never carried by colour alone: every tone has its own outline. */
export function Mark({ tone, size = 14 }: { tone: Tone; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true, className: `mark mark-${tone}` };
  switch (tone) {
    case 'good':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="7.5" fill="currentColor" />
          <path d="M4.4 8.3l2.5 2.5 4.8-5.2" fill="none" stroke="var(--mark-cut)" strokeWidth="2" />
        </svg>
      );
    case 'bad':
      return (
        <svg {...common}>
          <rect x="0.5" y="0.5" width="15" height="15" fill="currentColor" />
          <path d="M4.5 4.5l7 7m0-7l-7 7" fill="none" stroke="var(--mark-cut)" strokeWidth="2" />
        </svg>
      );
    case 'caution':
      return (
        <svg {...common}>
          <path d="M8 0.8L15.6 15H0.4z" fill="currentColor" />
          <path d="M8 5.6v4.6M8 11.4v1.8" fill="none" stroke="var(--mark-cut)" strokeWidth="1.8" />
        </svg>
      );
    case 'wait':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M8 4.2V8l2.6 1.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      );
    case 'live':
      return (
        <svg {...common}>
          <rect className="bar b1" x="1" y="3" width="3" height="10" fill="currentColor" />
          <rect className="bar b2" x="6.5" y="3" width="3" height="10" fill="currentColor" />
          <rect className="bar b3" x="12" y="3" width="3" height="10" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M5 8h6" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
  }
}

export function Tag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`tag tag-${tone}`}>
      <Mark tone={tone} size={12} />
      <span>{children}</span>
    </span>
  );
}

/** A pass or fail row: shape, word, then what was checked. */
export function CheckRow({ ok, label, children }: { ok: boolean | null | undefined; label?: ReactNode; children: ReactNode }) {
  const tone: Tone = ok === true ? 'good' : ok === false ? 'bad' : 'neutral';
  return (
    <li className={`check check-${tone}`}>
      <span className="check-state">
        <Mark tone={tone} size={13} />
        <span>{label ?? (ok === true ? 'OK' : ok === false ? 'Fail' : 'Unknown')}</span>
      </span>
      <div className="check-body">{children}</div>
    </li>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
      } finally {
        area.remove();
      }
    }
    setDone(true);
    window.setTimeout(() => setDone(false), 1400);
  };
  return (
    <button type="button" className="copy" onClick={copy} aria-label={`${label}: ${value.slice(0, 80)}`}>
      {done ? 'Copied' : label}
    </button>
  );
}

export function Hash({ value, chars = 12, full = false }: { value?: string | null; chars?: number; full?: boolean }) {
  if (!value) return <span className="mono muted">not set</span>;
  return (
    <span className={`hash${full ? ' hash-full' : ''}`}>
      <code className="mono" title={value}>
        {full ? value : short(value, chars)}
      </code>
      <CopyButton value={value} />
    </span>
  );
}

export function Notice({ tone, title, children }: { tone: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      <Mark tone={tone} size={16} />
      <div className="notice-body">
        {title && <div className="notice-title">{title}</div>}
        {children && <div className="notice-text">{children}</div>}
      </div>
    </div>
  );
}

export function Loading({ children = 'Loading' }: { children?: ReactNode }) {
  return (
    <p className="loading">
      <Mark tone="live" size={14} />
      <span>{children}</span>
    </p>
  );
}

const KEYWORDS =
  /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|IS|NULL|DELETE|UPDATE|INSERT|INTO|SET|VALUES|DROP|TABLE|TRUNCATE|ALTER|ADD|CREATE|JOIN|LEFT|RIGHT|INNER|ON|AS|EXISTS|CASCADE|COMMIT|ROLLBACK|BEGIN|LIMIT|ORDER|BY|GROUP|HAVING|DISTINCT|UNION|RETURNING|WITH|CASE|WHEN|THEN|ELSE|END|LIKE|ARRAY|INTERVAL)\b/gi;

/** SQL as plain text with quiet emphasis. Never parsed as markup. */
export function Sql({ text, className = '', plain = false }: { text?: string | null; className?: string; plain?: boolean }) {
  const value = text ?? '';
  if (plain) return <pre className={`sql ${className}`}>{value}</pre>;
  const parts: ReactNode[] = [];
  // Strings first, so words inside a literal are not treated as keywords.
  value.split(/('(?:[^']|'')*')/g).forEach((chunk, i) => {
    if (i % 2 === 1) {
      parts.push(
        <span className="sql-str" key={i}>
          {chunk}
        </span>,
      );
      return;
    }
    let last = 0;
    for (const m of chunk.matchAll(KEYWORDS)) {
      const at = m.index ?? 0;
      if (at > last) parts.push(chunk.slice(last, at));
      parts.push(
        <span className="sql-kw" key={`${i}-${at}`}>
          {m[0]}
        </span>,
      );
      last = at + m[0].length;
    }
    if (last < chunk.length) parts.push(chunk.slice(last));
  });
  return <pre className={`sql ${className}`}>{parts}</pre>;
}

export function Section({
  id,
  index,
  title,
  aside,
  children,
}: {
  id: string;
  index?: string;
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section" id={id} aria-labelledby={`${id}-title`}>
      <header className="section-head">
        {index && <span className="section-index mono">{index}</span>}
        <h2 className="section-title" id={`${id}-title`}>
          {title}
        </h2>
        {aside && <div className="section-aside">{aside}</div>}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Fold({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className="fold" open={open}>
      <summary>{summary}</summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/** One broken section must not take the rest of the run page down with it. */
export class Boundary extends Component<{ children: ReactNode; label?: string }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { failed: e instanceof Error ? e.message : String(e) };
  }
  componentDidCatch(e: unknown, info: ErrorInfo) {
    console.error(this.props.label, e, info.componentStack);
  }
  render() {
    if (this.state.failed) {
      return (
        <Notice tone="bad" title={`This part could not be shown${this.props.label ? `: ${this.props.label}` : ''}.`}>
          <span className="mono">{this.state.failed}</span>
        </Notice>
      );
    }
    return this.props.children;
  }
}
