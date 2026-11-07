import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { api, errorText } from '../api/client';
import type { PublicInfo } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { LandingContext } from '../landing/context';
import { ExhibitRail } from '../landing/ExhibitRail';
import { Hero } from '../landing/Hero';
import '../landing/landing.css';
import { matches, PHONE, REDUCED } from '../lib/media';
import { navigate } from '../lib/router';
import { useTheme } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { PrimaryButton } from '../ui/Halftone';

// The hero ships with the main chunk. The chapters arrive after first paint.
const Chapters = lazy(() => import('../landing/chapters/Chapters'));

interface SmoothScroll {
  resize: () => void;
  scrollTo: (top: number, options?: { duration?: number }) => void;
}

/** Smooth wheel on this route only, and never for touch or reduced motion. The nav's jumps stay in jump() below, so there is
 *  one place that knows where a chapter's heading lands. */
function useSmoothWheel(): RefObject<SmoothScroll | null> {
  const smooth = useRef<SmoothScroll | null>(null);
  useEffect(() => {
    if (matches(REDUCED) || matches(PHONE) || matches('(pointer: coarse)')) return;
    let stopped = false;
    let destroy: (() => void) | undefined;
    void import('lenis').then(({ default: Lenis }) => {
      if (stopped) return;
      const lenis = new Lenis({ lerp: 0.1, autoRaf: true });
      smooth.current = lenis;
      destroy = () => {
        smooth.current = null;
        lenis.destroy();
      };
    });
    return () => {
      stopped = true;
      destroy?.();
    };
  }, []);
  return smooth;
}

function useHashJump() {
  // A link that arrives with a section in it. The chapters load after first paint, so this waits for the section to exist.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!id || id === 'top') return;
    let tries = 0;
    const timer = window.setInterval(() => {
      const el = document.getElementById(id);
      tries += 1;
      if (el) {
        window.clearInterval(timer);
        window.setTimeout(() => window.scrollTo({ top: jumpTarget(el), behavior: 'instant' }), 300);
      } else if (tries > 40) window.clearInterval(timer);
    }, 100);
    return () => window.clearInterval(timer);
  }, []);
}

/** Where a jump to a chapter should land: its heading clear of the nav. A pinned drawing that scroll draws would be blank
 *  at its start, so a jump goes to the end of its pin, where the stage is still in place and the drawing is finished. */
function jumpTarget(el: HTMLElement): number {
  const top = el.getBoundingClientRect().top + window.scrollY;
  const nav = document.querySelector<HTMLElement>('.land-nav')?.offsetHeight ?? 0;
  if (el.dataset.jump === 'end') return top + el.offsetHeight - window.innerHeight;
  if (el.classList.contains('ch-pin')) return top;
  return top - nav;
}

export function SignInPage({ linkedPage = false }: { linkedPage?: boolean }) {
  const { enterAsGuest } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const info = useAsync<PublicInfo>(() => api.publicInfo());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChapters, setShowChapters] = useState(false);
  const [ctaOffscreen, setCtaOffscreen] = useState(false);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const guestOff = info.data?.open_demo === false;

  const smooth = useSmoothWheel();
  useHashJump();

  const jump = (e: MouseEvent<HTMLAnchorElement>) => {
    const id = e.currentTarget.hash.slice(1);
    const el = id ? document.getElementById(id) : null;
    if (!el) return;
    e.preventDefault();
    history.pushState(null, '', `#${id}`);
    const top = jumpTarget(el);
    // The chapters may have just arrived, and the smooth wheel clamps to the page height it last measured. Until it has
    // loaded, a smooth scroll here would be undone when it starts, so this jumps at once.
    if (smooth.current) {
      smooth.current.resize();
      smooth.current.scrollTo(top, { duration: 0.6 });
    } else {
      window.scrollTo({ top, behavior: 'instant' });
    }
  };

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
        <a
          href="#top"
          className="skip-link"
          onClick={(e) => {
            e.preventDefault();
            ctaRef.current?.focus();
          }}
        >
          Skip to Race the agent
        </a>
        <header className="land-nav">
          <a className="brand" href="#top" aria-label="Shadow Run, top of the page">
            <span className="wordmark">
              <span className="wordmark-mark" aria-hidden="true" />
              <span>Shadow Run</span>
            </span>
          </a>
          <nav className="land-nav-links" aria-label="On this page">
            <a href="#happened" onClick={jump}>
              It has happened
            </a>
            <a href="#blueprint" onClick={jump}>
              The blueprint
            </a>
            <a href="#run" onClick={jump}>
              The run
            </a>
            <a href="#break" onClick={jump}>
              Try to break it
            </a>
            <a href="#got-around" onClick={jump}>
              The finding
            </a>
            <a href="#results" onClick={jump}>
              Results
            </a>
            <a href="#who-pays" onClick={jump}>
              Who pays
            </a>
          </nav>
          <div className="land-nav-right">
            <button type="button" className="textbtn" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            {!guestOff && (
              <PrimaryButton type="button" className="land-nav-cta" disabled={busy} onClick={() => void enter('/race')} style={{ visibility: ctaOffscreen ? 'visible' : 'hidden' }}>
                {busy ? 'Entering' : 'Race the agent'}
              </PrimaryButton>
            )}
          </div>
        </header>
        <span id="top" />
        {linkedPage && guestOff && (
          <p className="land-linked" role="status">
            Sign in to see the page you were linked to. <a href="#sign-in">Sign in with a password</a>.
          </p>
        )}
        <ExhibitRail />
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
