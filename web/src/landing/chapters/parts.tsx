import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Receipt } from '../../api/types';
import { PINNABLE, useMedia, usePhone, useReducedMotion } from '../../lib/media';
import { Label } from '../../ui/Label';

/** Pinned on a desktop, a swipe pager on a phone, and plain figures for anyone who asked for less motion. */
export type Mode = 'pinned' | 'pager' | 'flat';

export function useMode(): Mode {
  const reduced = useReducedMotion();
  const phone = usePhone();
  const pinnable = useMedia(PINNABLE);
  return reduced ? 'flat' : phone ? 'pager' : pinnable ? 'pinned' : 'flat';
}

/** Fires once, when the element is a fifth of the way into view, and doesn't reverse on scroll up. */
export function useReveal(ref: RefObject<HTMLElement>): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setOn(true);
          observer.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return on;
}

export function useSize(ref: RefObject<HTMLElement>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  // The box may only exist once data has arrived, so this watches for the element on every render.
  const [el, setEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current !== el) setEl(ref.current);
  });
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return size;
}

export const pad = (n: number) => String(n).padStart(2, '0');

export function ChapterHead({ id, label, title, lead }: { id: string; label: string; title: ReactNode; lead?: ReactNode }) {
  return (
    <header className="ch-head">
      <Label>{label}</Label>
      <h2 className="t-display-l ch-title" id={id}>
        {title}
      </h2>
      {lead && <p className="t-body-l ch-lead">{lead}</p>}
    </header>
  );
}

/** A horizontal pager. The page itself never scrolls sideways: only this track does. */
export function Pager({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  return (
    <div className="pager" role="group" aria-label={label}>
      <div
        className="pager-track"
        ref={track}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
      >
        {children}
      </div>
      <div className="pager-count t-label" aria-live="polite">
        {pad(index + 1)} / {pad(count)}
      </div>
    </div>
  );
}

/** A small segmented progress pill, one segment per step. */
export function Segments({ count, index }: { count: number; index: number }) {
  return (
    <div className="segments" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} className={i === index ? 'is-on' : i < index ? 'is-past' : undefined} />
      ))}
    </div>
  );
}

export function groupOf(items: Receipt[] | undefined, name: string): Receipt[] {
  return (items ?? []).filter((r) => r.group === name);
}

/** How many of a group say the same word, counted from the receipts rather than written down. */
export function tally(items: Receipt[], word: string): { hit: number; total: number } | null {
  if (!items.length) return null;
  return { hit: items.filter((r) => r.value === word).length, total: items.length };
}

/** "403 maker-checker: ..." into its code and its words. */
export function parseGot(got: string | undefined): { code: string; text: string } | null {
  const m = got?.match(/^(\d{3})\s+(.*)$/s);
  return m ? { code: m[1], text: m[2] } : null;
}
