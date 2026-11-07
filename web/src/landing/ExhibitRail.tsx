import { useEffect, useRef, useState } from 'react';

const EXHIBITS: { id: string; name: string }[] = [
  { id: 'top', name: 'The run' },
  { id: 'happened', name: 'It has happened' },
  { id: 'blueprint', name: 'The blueprint' },
  { id: 'run', name: 'The run, recorded' },
  { id: 'break', name: 'Try to break it' },
  { id: 'got-around', name: 'The finding' },
  { id: 'results', name: 'Results' },
  { id: 'vultr', name: 'On Vultr' },
  { id: 'who-pays', name: 'Who pays' },
];

/** A ruler on the right edge with a needle that settles on the exhibit in view and names it. Desktop only, and decoration:
 * the nav already carries the same links, so it's hidden from screen readers and from the pointer. */
export function ExhibitRail() {
  const [state, setState] = useState({ k: 0, at: 0 });
  const frame = useRef(0);
  useEffect(() => {
    const read = () => {
      frame.current = 0;
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - innerHeight);
      const k = Math.min(1, Math.max(0, scrollY / max));
      let at = 0;
      EXHIBITS.forEach((e, i) => {
        const el = e.id === 'top' ? null : document.getElementById(e.id);
        if (el && el.getBoundingClientRect().top < innerHeight * 0.45) at = i;
      });
      setState((s) => (Math.abs(s.k - k) < 0.002 && s.at === at ? s : { k, at }));
    };
    const onScroll = () => {
      if (!frame.current) frame.current = requestAnimationFrame(read);
    };
    read();
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    return () => {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);
  const n = String(state.at + 1).padStart(2, '0');
  return (
    <div className="xr" aria-hidden="true">
      <div className="xr-ticks" />
      <div className={`xr-needle${state.k > 0.5 ? ' is-low' : ''}`} style={{ transform: `translateY(calc(${(state.k * 100).toFixed(2)} * (var(--xr-h) / 100)))` }}>
        <span className="xr-read mono">
          {n} · {EXHIBITS[state.at].name}
        </span>
      </div>
    </div>
  );
}
