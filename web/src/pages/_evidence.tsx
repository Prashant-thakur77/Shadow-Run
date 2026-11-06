import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { matches, REDUCED } from '../lib/media';
import { Label } from '../ui/Label';

/** The one header the proof pages share: bracket label, title, one sentence, and anything measured beside it. */
export function PageHead({ label, title, lead, aside }: { label: string; title: ReactNode; lead: ReactNode; aside?: ReactNode }) {
  return (
    <header className="ev-head">
      <div className="ev-head-main">
        <Label>{label}</Label>
        <h1 className="page-title">{title}</h1>
        <p className="page-lead">{lead}</p>
      </div>
      {aside && <div className="ev-head-aside">{aside}</div>}
    </header>
  );
}

export type Sight = 'plain' | 'armed' | 'seen';

/** For entrances that play once. `plain` shows everything at once, so reduced motion and a page that never
 *  scrolls lose nothing. `armed` only ever hides drawing, and turns to `seen` the first time it's on screen. */
export function useFirstSight<T extends HTMLElement>(ref: RefObject<T>, { belowFold = false, margin = '0px 0px -8% 0px' }: { belowFold?: boolean; margin?: string } = {}): Sight {
  const [sight, setSight] = useState<Sight>('plain');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || matches(REDUCED) || typeof IntersectionObserver !== 'function') return;
    // Offsets ignore transforms, so this is where it will rest, even while the page is still rising into place.
    if (belowFold) {
      let top = 0;
      for (let n: HTMLElement | null = el; n; n = n.offsetParent as HTMLElement | null) top += n.offsetTop;
      if (top - window.scrollY < window.innerHeight) return;
    }
    setSight((s) => (s === 'plain' ? 'armed' : s));
  }, [ref, belowFold]);
  useEffect(() => {
    const el = ref.current;
    if (!el || sight !== 'armed') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setSight('seen');
          observer.disconnect();
        }
      },
      { rootMargin: margin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, sight, margin]);
  return sight;
}
