import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { matches, REDUCED } from '../lib/media';

export interface ScrubOptions {
  /** Share of the gap closed per frame at 60 fps. Smaller is smoother. */
  smooth?: number;
  /** Called with the smoothed progress, 0 to 1, whenever it changes. */
  onProgress?: (p: number) => void;
  /** Stops the loop and holds progress at 1, for the flat layouts. */
  disabled?: boolean;
}

/** Progress of a tall section past its sticky stage. Nothing runs until the section is near the viewport, and
 *  the DOM is left alone apart from `--p` on the element: no JavaScript pinning, so React keeps its tree. */
export function useScrub<T extends HTMLElement>(ref: RefObject<T>, { smooth = 0.14, onProgress, disabled = false }: ScrubOptions = {}) {
  const callback = useRef(onProgress);
  callback.current = onProgress;
  // The section may only exist once data has arrived, so this watches for the element on every render.
  const [el, setEl] = useState<T | null>(null);
  useLayoutEffect(() => {
    if (ref.current !== el) setEl(ref.current);
  });

  useEffect(() => {
    if (!el) return;
    const write = (p: number) => {
      el.style.setProperty('--p', p.toFixed(4));
      callback.current?.(p);
    };
    if (disabled || matches(REDUCED)) {
      write(1);
      return;
    }

    let frame = 0;
    let visible = false;
    let current = -1;
    let last = 0;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const travel = rect.height - window.innerHeight;
      if (travel <= 0) return rect.top <= 0 ? 1 : 0;
      return Math.min(1, Math.max(0, -rect.top / travel));
    };
    const tick = (now: number) => {
      frame = 0;
      if (!visible) return;
      const target = measure();
      if (current < 0) current = target;
      // The same smoothing at any refresh rate.
      const dt = last ? Math.min(100, now - last) : 16.7;
      last = now;
      const share = 1 - Math.pow(1 - smooth, dt / 16.7);
      const next = Math.abs(target - current) < 0.0004 ? target : current + (target - current) * share;
      if (next !== current || current === target) {
        const moved = next !== current;
        current = next;
        if (moved) write(current);
      }
      frame = requestAnimationFrame(tick);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible && !frame) {
          last = 0;
          // Arriving from an anchor link or a reload lands in the right state at once.
          current = measure();
          write(current);
          frame = requestAnimationFrame(tick);
        }
      },
      { rootMargin: '10% 0px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [el, smooth, disabled]);
}
