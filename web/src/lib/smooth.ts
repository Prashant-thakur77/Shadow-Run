import { matches, PHONE, REDUCED } from './media';

/** The one smooth-scroll engine for every page: a wheel that glides instead of jumping, and pinned chapters that move one
 *  step per flick. Never on touch screens, phones or with reduced motion, where the native scroll is the right one. */

export interface SmoothScroll {
  scrollTo: (target: number | HTMLElement, options?: { duration?: number; easing?: (t: number) => number; immediate?: boolean; force?: boolean }) => void;
  on: (event: 'scroll', cb: () => void) => void;
  resize: () => void;
  scroll: number;
  targetScroll: number;
  isScrolling: boolean | string;
}

let instance: SmoothScroll | null = null;
let starting: Promise<SmoothScroll | null> | null = null;

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export function smoothScroll(): SmoothScroll | null {
  return instance;
}

export function startSmoothScroll(): Promise<SmoothScroll | null> {
  if (instance) return Promise.resolve(instance);
  if (starting) return starting;
  if (typeof window === 'undefined' || matches(REDUCED) || matches(PHONE) || matches('(pointer: coarse)')) return Promise.resolve(null);
  starting = import('lenis').then(({ default: Lenis }) => {
    const lenis = new Lenis({
      // A longer glide than the default, and a little less distance per wheel notch: calm, not sluggish.
      lerp: 0.085,
      wheelMultiplier: 0.85,
      // Code blocks, tables and panels that scroll on their own keep their own scroll.
      allowNestedScroll: true,
      autoRaf: true,
    }) as unknown as SmoothScroll;
    instance = lenis;
    (window as unknown as { __smooth?: SmoothScroll }).__smooth = lenis;
    snapSteps(lenis);
    return lenis;
  });
  return starting;
}

/** A pinned chapter marked `data-snap-steps="N"` holds one step per Nth of its scroll. When the wheel comes to rest inside
 *  it, the page glides to the centre of a step: forward or back by one if the reader moved a little, to the nearest one if
 *  they moved a lot. Outside such a chapter nothing changes. */
function snapSteps(lenis: SmoothScroll) {
  const rest = new WeakMap<HTMLElement, number>();
  let timer = 0;
  // After a glide the page sits on a step's centre, so the next check finds nothing to do: no flag needed.
  const settle = (heading: boolean) => {
    // Where the glide is going, not where it is: the step is chosen as soon as the hand stops.
    const y = heading ? lenis.targetScroll : window.scrollY;
    for (const el of document.querySelectorAll<HTMLElement>('[data-snap-steps]')) {
      const steps = Number(el.dataset.snapSteps);
      const top = el.getBoundingClientRect().top + window.scrollY;
      const travel = el.offsetHeight - window.innerHeight;
      if (!steps || travel <= 0 || y < top - 2 || y > top + travel + 2) continue;
      // Position in steps, where 0 is the centre of the first step.
      const f = ((y - top) / travel) * steps - 0.5;
      const was = rest.get(el);
      let i: number;
      if (was === undefined || Math.abs(f - was) > 1.5) i = Math.round(f);
      else if (Math.abs(f - was) < 0.12) i = was;
      else i = f > was ? was + 1 : was - 1;
      // Past the last step, or back before the first, the reader is leaving the chapter: let them go.
      if (i > steps - 1 || i < 0) {
        rest.delete(el);
        return;
      }
      rest.set(el, i);
      const target = top + (travel * (i + 0.5)) / steps;
      if (Math.abs(target - y) > 3) lenis.scrollTo(target, { duration: 0.75, easing: easeOut });
      return;
    }
  };
  // The wheel decides 140 ms after its last notch; any other way of scrolling (keys, the bar) is settled once the page stops.
  let wheelAt = 0;
  window.addEventListener('wheel', () => {
    wheelAt = performance.now();
    window.clearTimeout(timer);
    timer = window.setTimeout(() => settle(true), 140);
  }, { passive: true });
  lenis.on('scroll', () => {
    if (performance.now() - wheelAt < 400) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => settle(false), 200);
  });
}
