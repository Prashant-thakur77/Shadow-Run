import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api/client';
import type { PublicInfo } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { LandingContext } from '../landing/context';
import { Hero } from '../landing/Hero';
import '../landing/landing.css';
import { matches, PHONE, REDUCED } from '../lib/media';
import { navigate } from '../lib/router';
import { useTheme } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { PrimaryButton } from '../ui/Halftone';

// The hero ships with the main chunk. The chapters arrive after first paint.
const Chapters = lazy(() => import('../landing/chapters/Chapters'));

/** Smooth wheel on this route only, and never for touch or reduced motion. */
function useSmoothWheel() {
  useEffect(() => {
    if (matches(REDUCED) || matches(PHONE) || matches('(pointer: coarse)')) return;
    let stopped = false;
    let destroy: (() => void) | undefined;
    void import('lenis').then(({ default: Lenis }) => {
      if (stopped) return;
      const lenis = new Lenis({ lerp: 0.1, autoRaf: true, anchors: { offset: 20 } });
      destroy = () => lenis.destroy();
    });
    return () => {
      stopped = true;
      destroy?.();
    };
  }, []);
}

export function SignInPage() {
  const { enterAsGuest } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const info = useAsync<PublicInfo>(() => api.publicInfo());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChapters, setShowChapters] = useState(false);
  const [ctaOffscreen, setCtaOffscreen] = useState(false);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const guestOff = info.data?.open_demo === false;

  useSmoothWheel();

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShowChapters(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Exactly one guest button is exposed at any moment: the hero's while it's on screen, otherwise the nav's. Hidden
  // still has layout, so the observer keeps working, and the video scripts' one click can't match two buttons.
  // Measured before the first paint too. On a phone the hero's starts below the fold, and a script that picked it up in
  // the frame before the observer fired would wait on a button that had just been hidden.
  useLayoutEffect(() => {
    const el = ctaRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setCtaOffscreen(box.bottom <= 0 || box.top >= window.innerHeight);
    const observer = new IntersectionObserver(([entry]) => setCtaOffscreen(!entry.isIntersecting));
    observer.observe(el);
    return () => observer.disconnect();
  }, [guestOff]);

  const enter = useCallback(
    async (to?: string) => {
      setBusy(true);
      setError(null);
      // The page behind the landing renders as soon as there's a user, so it has to be in place first.
      if (to) navigate(to);
      try {
        await enterAsGuest();
      } catch (e) {
        if (to) navigate('/', { replace: true });
        setError(errorText(e));
        setBusy(false);
      }
    },
    [enterAsGuest],
  );

  const value = useMemo(() => ({ info: info.data, loading: info.loading, guestOff, busy, error, enter }), [info.data, info.loading, guestOff, busy, error, enter]);

  return (
    <LandingContext.Provider value={value}>
      <div className="land">
        <header className="land-nav">
          <a className="brand" href="#top" aria-label="Shadow Run, top of the page">
            <span className="wordmark">
              <span className="wordmark-mark" aria-hidden="true" />
              <span>Shadow Run</span>
            </span>
          </a>
          <nav className="land-nav-links" aria-label="On this page">
            <a href="#happened">It has happened</a>
            <a href="#blueprint">The blueprint</a>
            <a href="#run">The run</a>
            <a href="#break">Try to break it</a>
            <a href="#results">Results</a>
          </nav>
          <div className="land-nav-right">
            <button type="button" className="textbtn" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            {!guestOff && (
              <PrimaryButton type="button" className="land-nav-cta" disabled={busy} onClick={() => void enter()} style={{ visibility: ctaOffscreen ? 'visible' : 'hidden' }}>
                {busy ? 'Entering' : 'Continue as guest'}
              </PrimaryButton>
            )}
          </div>
        </header>
        <span id="top" />
        <Hero ctaRef={ctaRef} ctaOffscreen={ctaOffscreen} />
        {showChapters && (
          <Suspense fallback={null}>
            <Chapters />
          </Suspense>
        )}
      </div>
    </LandingContext.Provider>
  );
}
