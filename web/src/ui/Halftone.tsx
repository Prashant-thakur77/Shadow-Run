import { forwardRef, useRef, type ButtonHTMLAttributes, type PointerEvent, type ReactNode } from 'react';
import { cssVar, matches, PHONE, REDUCED } from '../lib/media';

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const CELL = 2; // CSS pixels per pattern cell
const GROW_MS = 240;

/** A 4×4 Bayer mask that grows from the edge the pointer came in by, thinning across the button so the label stays clear.
 *  The canvas exists only once someone hovers, and it paints only while the mask is moving. */
function useHalftone() {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef(0);
  const amount = useRef(0);

  const paint = (host: HTMLElement, fromRight: boolean, to: number, ms: number) => {
    if (!canvas.current) {
      const c = document.createElement('canvas');
      c.className = 'halftone-canvas';
      c.setAttribute('aria-hidden', 'true');
      host.prepend(c);
      canvas.current = c;
    }
    const c = canvas.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = host.clientWidth;
    const h = host.clientHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = cssVar('--invert-ink');
    const cols = Math.ceil(w / CELL);
    const rows = Math.ceil(h / CELL);
    const size = Math.max(1, Math.round(CELL * dpr * 0.5));
    const start = performance.now();
    const from = amount.current;
    cancelAnimationFrame(raf.current);
    const frame = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      amount.current = from + (to - from) * k;
      ctx.clearRect(0, 0, pw, ph);
      ctx.beginPath();
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const edge = (fromRight ? cols - 1 - x : x) / Math.max(1, cols - 1);
          // Dense at the entry edge and thin by the far one. The front travels with `amount`.
          const density = Math.max(0, amount.current * 1.55 - edge) * 0.42;
          if (BAYER[(y % 4) * 4 + (x % 4)] / 16 < density) ctx.rect(Math.round(x * CELL * dpr), Math.round(y * CELL * dpr), size, size);
        }
      }
      ctx.fill();
      if (k < 1) raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  };

  const onPointerEnter = (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse' || matches(REDUCED) || matches(PHONE)) return;
    const host = e.currentTarget;
    if (host.matches(':disabled')) return;
    const rect = host.getBoundingClientRect();
    paint(host, e.clientX > rect.left + rect.width / 2, 1, GROW_MS);
  };
  const onPointerLeave = (e: PointerEvent<HTMLElement>) => {
    if (!canvas.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    paint(e.currentTarget, e.clientX > rect.left + rect.width / 2, 0, GROW_MS * 0.66);
  };
  return { onPointerEnter, onPointerLeave };
}

/** The primary call to action. Hover is decoration only: it works the same with no pointer at all. */
export const PrimaryButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }>(function PrimaryButton({ className = '', children, ...rest }, ref) {
  const halftone = useHalftone();
  return (
    <button ref={ref} className={`btn btn-primary halftone-host ${className}`} {...halftone} {...rest}>
      {children}
    </button>
  );
});
