import { useEffect, useState } from 'react';

export const REDUCED = '(prefers-reduced-motion: reduce)';
export const PHONE = '(max-width: 719px)';
/** Too narrow for two rooms side by side, so the seam turns horizontal. */
export const STACKED = '(max-width: 999px)';
/** Enough room for a sticky stage to hold a whole chapter. */
export const PINNABLE = '(min-width: 1000px) and (min-height: 600px)';

export function matches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** CSS can't stop requestAnimationFrame, so every canvas and hook asks this itself. */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matches(query));
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setOn(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return on;
}

export const useReducedMotion = () => useMedia(REDUCED);
export const usePhone = () => useMedia(PHONE);

/** The value of a CSS custom property on the root, for code that paints pixels itself. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Calls back when the theme attribute flips, so a canvas can repaint in the new colours. */
export function onThemeChange(fn: () => void): () => void {
  const observer = new MutationObserver(fn);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
