import { startSmoothScroll } from './lib/smooth';
import { createContext, Fragment, lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorText } from './api/client';
import type { Health, ProdChecksum } from './api/types';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { short } from './lib/format';
import { Link, navigate, RouterProvider, useLocation } from './lib/router';
import { currentTarget } from './lib/target';
import { useTheme } from './lib/theme';
import { useAsync } from './lib/useAsync';
import { SignInPage } from './pages/SignIn';
import { Boundary, Loading, Mark } from './ui/bits';
import { ReseedButton } from './ui/ReseedButton';

// The landing page ships in the main chunk. Everything behind it loads when it is needed, so the first visit
// doesn't download the authenticated pages.
const load = {
  home: () => import('./pages/Home'),
  race: () => import('./pages/Race'),
  run: () => import('./pages/RunPage'),
  redteam: () => import('./pages/RedTeam'),
  target: () => import('./pages/Target'),
  incidents: () => import('./pages/Incidents'),
  receipts: () => import('./pages/Receipts'),
  results: () => import('./pages/Results'),
  audit: () => import('./pages/Audit'),
  whoPays: () => import('./pages/WhoPaysPage'),
};
const HomePage = lazy(() => load.home().then((m) => ({ default: m.HomePage })));
const RacePage = lazy(() => load.race().then((m) => ({ default: m.RacePage })));
const RunPage = lazy(() => load.run().then((m) => ({ default: m.RunPage })));
const RedTeamPage = lazy(() => load.redteam().then((m) => ({ default: m.RedTeamPage })));
const TargetPage = lazy(() => load.target().then((m) => ({ default: m.TargetPage })));
const IncidentsPage = lazy(() => load.incidents().then((m) => ({ default: m.IncidentsPage })));
const ReceiptsPage = lazy(() => load.receipts().then((m) => ({ default: m.ReceiptsPage })));
const ResultsPage = lazy(() => load.results().then((m) => ({ default: m.ResultsPage })));
const AuditPage = lazy(() => load.audit().then((m) => ({ default: m.AuditPage })));
const WhoPaysPage = lazy(() => load.whoPays().then((m) => ({ default: m.WhoPaysPage })));

/** Once someone is in, fetch the other pages quietly, so moving between them doesn't show a loading state. */
function usePreloadPages(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      for (const fn of Object.values(load)) void fn();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [active]);
}

export function App() {
  // One smooth wheel for every page, started once (lib/smooth.ts decides where it shouldn't run).
  useEffect(() => {
    void startSmoothScroll();
  }, []);
  return (
    <RouterProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </RouterProvider>
  );
}

// The race signs a guest in itself, so a link to it goes straight to the race.
const PUBLIC_PATHS = ['/results', '/incidents', '/receipts', '/race', '/who-pays'];
// A link to one of these is a promise to show that page, such as a pull request comment's Full report. On the open demo a
// guest goes straight in. Elsewhere it's the landing page, which has the sign-in.
const isGuestDoor = (path: string) => /^\/runs\/[^/]+\/?$/.test(path) || ['/guardrails', '/redteam', '/audit'].includes(path);

function Shell() {
  const { user, ready, enterAsGuest } = useAuth();
  const { path } = useLocation();
  const runMatch = path.match(/^\/runs\/([^/]+)\/?$/);
  usePreloadPages(!!user);

  const [noGuest, setNoGuest] = useState(false);
  const tried = useRef(false);
  const door = isGuestDoor(path);
  useEffect(() => {
    // Back to a clean slate once someone is in, so a session that ends later gets the same chance again.
    if (user) tried.current = false;
    if (!ready || user || !door || tried.current) return;
    tried.current = true;
    enterAsGuest().catch(() => setNoGuest(true));
  }, [ready, user, door, enterAsGuest]);

  useEffect(() => {
    const base = 'Shadow Run';
    const named = NAV.find((n) => n.href === path && n.href !== '/');
    document.title = runMatch ? `Run ${decodeURIComponent(runMatch[1])} · ${base}` : path === '/race' ? `The race · ${base}` : named ? `${named.label} · ${base}` : base;
  }, [runMatch?.[1], path]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return (
      <div className="boot">
        <Loading>Checking who you are</Loading>
      </div>
    );
  }

  if (!user && door && !noGuest) {
    return (
      <div className="boot">
        <Loading>Opening this page as a guest</Loading>
      </div>
    );
  }

  // Evidence is public, like the README. Everything else starts at the landing page.
  if (!user && !PUBLIC_PATHS.includes(path)) return <SignInPage linkedPage={door} />;

  let page = <NotFound />;
  if (path === '/') page = <HomePage />;
  else if (path === '/race') page = <RacePage />;
  else if (runMatch) page = <RunPage key={runMatch[1]} id={decodeURIComponent(runMatch[1])} />;
  else if (path === '/redteam') page = <RedTeamPage />;
  else if (path === '/guardrails') page = <TargetPage />;
  else if (path === '/incidents') page = <IncidentsPage />;
  else if (path === '/receipts') page = <ReceiptsPage />;
  else if (path === '/results') page = <ResultsPage />;
  else if (path === '/audit') page = <AuditPage />;
  else if (path === '/who-pays') page = <WhoPaysPage />;

  return (
    <ProdProvider active={!!user}>
      <div className="app">
        <Header />
        <main className="main">
          <Boundary key={path} label="page">
            <Suspense
              fallback={
                <div className="page">
                  <Loading />
                </div>
              }
            >
              <AfterReseed>{page}</AfterReseed>
            </Suspense>
          </Boundary>
        </main>
        <StatusBar />
        <BottomBar />
      </div>
    </ProdProvider>
  );
}

/** A reseed resets rows and learned guardrails, so whatever page is open reads everything again. */
function AfterReseed({ children }: { children: ReactNode }) {
  const { reseeds } = useProd();
  return <Fragment key={reseeds}>{children}</Fragment>;
}

function NotFound() {
  return (
    <div className="page notfound">
      <div className="t-dot" aria-hidden="true">
        404
      </div>
      <h1 className="page-title">Nothing here</h1>
      <p>
        <Link href="/">Back to new task</Link>
      </p>
    </div>
  );
}

const NAV = [
  { href: '/', label: 'New task' },
  { href: '/race', label: 'Race' },
  { href: '/redteam', label: 'Red team' },
  { href: '/guardrails', label: 'Guardrails' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/receipts', label: 'Receipts' },
  { href: '/results', label: 'Results' },
  { href: '/audit', label: 'Audit' },
  { href: '/who-pays', label: 'Who pays' },
];

function useIsActive() {
  const { path } = useLocation();
  // A run page belongs to no tab: it may have started from New task, the Race, a pull request or the API.
  return (href: string) => path === href;
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-mark" aria-hidden="true" />
      <span>Shadow Run</span>
    </span>
  );
}

function Nav() {
  const { path } = useLocation();
  const isActive = useIsActive();
  const navRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLSpanElement>(null);

  // One underline that slides. The links themselves never move.
  useLayoutEffect(() => {
    const place = () => {
      const nav = navRef.current;
      const rail = railRef.current;
      if (!nav || !rail) return;
      const link = nav.querySelector<HTMLElement>('[aria-current="page"]');
      rail.style.opacity = link ? '1' : '0';
      if (link) rail.style.transform = `translateX(${link.offsetLeft + 10}px) scaleX(${Math.max(1, link.offsetWidth - 20)})`;
    };
    place();
    void document.fonts?.ready.then(place);
    // The nav's own box, since the chip beside it can also push it onto its own row.
    const observer = new ResizeObserver(place);
    if (navRef.current) observer.observe(navRef.current);
    return () => observer.disconnect();
  }, [path]);

  return (
    <nav className="nav" aria-label="Main" ref={navRef}>
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} className={isActive(n.href) ? 'nav-link is-active' : 'nav-link'} aria-current={isActive(n.href) ? 'page' : undefined}>
          {n.label}
        </Link>
      ))}
      <span className="nav-rail" ref={railRef} aria-hidden="true" />
    </nav>
  );
}

/** The one way in, under one name, wherever it appears. */
function GuestDoor({ className, label = 'Continue as guest' }: { className: string; label?: string }) {
  const { enterAsGuest } = useAuth();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A deployment with no open demo has no guest, so the way in is the sign-in on the landing page.
  if (failed) {
    return (
      <Link href="/" className={className}>
        Sign in
      </Link>
    );
  }
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        enterAsGuest().catch(() => {
          setFailed(true);
          setBusy(false);
        });
      }}
    >
      {busy ? 'Entering' : label}
    </button>
  );
}

function Header() {
  const { user, signOut } = useAuth();
  const [theme, toggleTheme] = useTheme();
  return (
    <header className="topbar">
      <div className="topbar-row">
        <Link href="/" className="brand" aria-label="Shadow Run, new task">
          <Wordmark />
        </Link>
        <Nav />
        <div className="topbar-right">
          {user && <ProdIndicator />}
          <div className="topbar-wide">
            {user ? (
              <IdentitySwitch />
            ) : (
              <GuestDoor className="btn btn-small" />
            )}
            <button type="button" className="textbtn" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            {user && (
              <button
                type="button"
                className="textbtn"
                onClick={() => {
                  navigate('/');
                  void signOut();
                }}
              >
                Sign out
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/** Phones: five places in a fixed bar, with the rest one tap away behind More. */
function BottomBar() {
  const { user, signOut } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const { path } = useLocation();
  const isActive = useIsActive();
  const { unseeded } = useProd();
  const sheet = useRef<HTMLDialogElement>(null);
  const items = user ? NAV.filter((n) => ['/', '/race', '/redteam', '/incidents'].includes(n.href)) : NAV.filter((n) => ['/race', '/incidents', '/receipts', '/results'].includes(n.href));
  const rest = user ? NAV.filter((n) => !items.some((i) => i.href === n.href)) : [];

  useEffect(() => {
    sheet.current?.close();
  }, [path]);

  return (
    <>
      <nav className="bottombar" aria-label="Main, phone">
        {!user && <GuestDoor className="bottombar-link" label="Guest" />}
        {items.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(n.href) ? 'bottombar-link is-active' : 'bottombar-link'} aria-current={isActive(n.href) ? 'page' : undefined}>
            {n.label}
          </Link>
        ))}
        {user && (
          <button type="button" className="bottombar-link" onClick={() => sheet.current?.showModal()}>
            <span className="bottombar-more">
              More
              {unseeded && <i className="bottombar-dot" aria-hidden="true" />}
              {unseeded && <span className="sr-only">, prod has changed since the seed</span>}
            </span>
          </button>
        )}
      </nav>
      {user && (
        <dialog
          ref={sheet}
          className="more-sheet"
          aria-label="More"
          onClick={(e) => {
            if (e.target === sheet.current) sheet.current?.close();
          }}
        >
          <div className="more-sheet-body">
            <SeedRow />
            <ul className="more-sheet-links">
              {rest.map((n) => (
                <li key={n.href}>
                  <Link href={n.href} aria-current={isActive(n.href) ? 'page' : undefined}>
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
            <IdentitySwitch />
            <div className="more-sheet-row">
              <button type="button" className="btn" onClick={toggleTheme}>
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  sheet.current?.close();
                  navigate('/');
                  void signOut();
                }}
              >
                Sign out
              </button>
              <button type="button" className="btn" onClick={() => sheet.current?.close()}>
                Close
              </button>
            </div>
          </div>
        </dialog>
      )}
    </>
  );
}

interface ProdStatus {
  data: ProdChecksum | null;
  failed: boolean;
  /** The hash moved while this page was open: to something new, or back to the seed. */
  changed: 'moved' | 'seed' | null;
  /** A demo target's prod differs from its last reseed, because of a run here or another visitor's. */
  unseeded: boolean;
  reseeding: boolean;
  /** What the last press of Reseed came to, for a few seconds. */
  reseedNote: { text: string; failed: boolean } | null;
  reseed: () => Promise<void>;
  reseeds: number;
}

const ProdContext = createContext<ProdStatus>({ data: null, failed: false, changed: null, unseeded: false, reseeding: false, reseedNote: null, reseed: async () => {}, reseeds: 0 });
const useProd = () => useContext(ProdContext);

/** One measurement of prod, for the chip in the header and the More sheet on phones. */
function ProdProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const [data, setData] = useState<ProdChecksum | null>(null);
  const [failed, setFailed] = useState(false);
  const [changed, setChanged] = useState<ProdStatus['changed']>(null);
  const [unseeded, setUnseeded] = useState(false);
  const [reseeding, setReseeding] = useState(false);
  const [reseedNote, setReseedNote] = useState<ProdStatus['reseedNote']>(null);
  const [reseeds, setReseeds] = useState(0);
  const last = useRef<string | undefined>(undefined);
  const lastTarget = useRef<string | undefined>(undefined);
  const measureNow = useRef<() => Promise<void>>(async () => {});
  const noteTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let flash: number | undefined;
    const measure = async () => {
      try {
        const target = currentTarget();
        const res = await api.prodChecksum(target);
        if (stopped || target !== currentTarget()) return;
        setFailed(false);
        setData(res);
        // Only a reseed defines the seed, so until one has happened this stays false and nothing is claimed.
        setUnseeded(res.changed_from_seed === true && target.startsWith('demo'));
        // Moving to another target is not a change to prod.
        const sameTarget = lastTarget.current === target;
        lastTarget.current = target;
        if (sameTarget && last.current && res.digest && res.digest !== last.current) {
          // An undo that restores the seed is good news, and "changed" beside it reads as the opposite.
          setChanged(res.digest === res.seed_digest ? 'seed' : 'moved');
          window.clearTimeout(flash);
          flash = window.setTimeout(() => setChanged(null), 6000);
        }
        last.current = res.digest;
      } catch {
        if (!stopped) setFailed(true);
      }
    };
    measureNow.current = measure;
    void measure();
    const timer = window.setInterval(measure, 15000);
    window.addEventListener('sr:prod-changed', measure);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(flash);
      window.removeEventListener('sr:prod-changed', measure);
    };
  }, [active]);

  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  const reseed = useCallback(async () => {
    setReseeding(true);
    setReseedNote(null);
    window.clearTimeout(noteTimer.current);
    let note: ProdStatus['reseedNote'];
    try {
      await api.demoReset(currentTarget());
      // Asked for, so it isn't flagged as a surprise on the next measurement.
      last.current = undefined;
      await measureNow.current();
      setReseeds((n) => n + 1);
      note = { text: 'Reseeded', failed: false };
    } catch (e) {
      note = { text: `Could not reseed. ${errorText(e)}`, failed: true };
    }
    setReseeding(false);
    setReseedNote(note);
    noteTimer.current = window.setTimeout(() => setReseedNote(null), 6000);
  }, []);

  const value = useMemo(() => ({ data, failed, changed, unseeded, reseeding, reseedNote, reseed, reseeds }), [data, failed, changed, unseeded, reseeding, reseedNote, reseed, reseeds]);
  return <ProdContext.Provider value={value}>{children}</ProdContext.Provider>;
}

function ProdIndicator() {
  const { data, failed, changed, unseeded, reseeding, reseedNote, reseed } = useProd();
  const seedLine = unseeded || reseedNote;
  const measuredFrom = data?.digest ? `Prod checksum ${data.digest}, LSN ${data.lsn ?? 'unknown'}. Measured by Shadow Run's own server, outside the sandbox.` : undefined;
  return (
    <span className={`prod${changed === 'moved' ? ' is-changed' : ''}${seedLine ? ' has-seed-line' : ''}`} title={measuredFrom && data?.seed_digest ? `${measuredFrom} Seed checksum ${data.seed_digest}.` : measuredFrom}>
      <span className="prod-main">
        <span className="prod-label">{data?.files !== undefined ? 'Prod server' : 'Prod'}</span>
        <code className="mono prod-hash">{failed ? 'unavailable' : data?.digest ? short(data.digest, 8).replace('…', '') : '…'}</code>
        {changed && <span className="prod-changed">{changed === 'seed' ? 'back at the seed' : 'changed'}</span>}
      </span>
      {seedLine && (
        <span className="prod-seed" role="status">
          {unseeded && <span title={reseedNote?.failed ? reseedNote.text : undefined}>{reseedNote?.failed ? 'Could not reseed' : 'changed since the seed'}</span>}
          {unseeded && (
            <ReseedButton className="textbtn prod-reseed" busy={reseeding} onConfirm={() => void reseed()} />
          )}
          {!unseeded && reseedNote && <span>{reseedNote.text}</span>}
        </span>
      )}
    </span>
  );
}

/** Phones: the chip has room for the words and no room for a good tap target, so the button lives here. */
function SeedRow() {
  const { unseeded, reseeding, reseedNote, reseed } = useProd();
  if (!unseeded && !reseedNote) return null;
  return (
    <div className="more-sheet-seed" role="status">
      <p>{reseedNote?.failed ? reseedNote.text : unseeded ? 'Prod has changed since the seed. A run here, or another visitor, changed it.' : reseedNote?.text}</p>
      {unseeded && (
        <ReseedButton busy={reseeding} onConfirm={() => void reseed()} />
      )}
    </div>
  );
}

function IdentitySwitch() {
  const { user, switchTo } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = ['judge', 'reviewer'];
  if (user && !names.includes(user.username)) names.push(user.username);

  const go = async (name: string) => {
    if (name === user?.username) return;
    setBusy(true);
    setError(null);
    try {
      await switchTo(name);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="identity" role="group" aria-label="Signed in as" title={error ?? undefined}>
      <span className="identity-label">Signed in as</span>
      <div className="seg">
        {names.map((n) => (
          <button key={n} type="button" className={n === user?.username ? 'seg-btn is-on' : 'seg-btn'} aria-pressed={n === user?.username} disabled={busy} onClick={() => void go(n)}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusBar() {
  const health = useAsync<Health>(() => api.health());
  const h = health.data;
  if (health.error) {
    return (
      <footer className="statusbar">
        <span>Health check failed: {health.error}</span>
      </footer>
    );
  }
  if (!h) return <footer className="statusbar" aria-hidden="true" />;
  const items: { ok: boolean | undefined; text: string }[] = [
    { ok: h.runner?.host?.kvm_rw, text: `runner ${h.runner?.host?.hostname ?? 'unknown'}, /dev/kvm` },
    { ok: h.runner?.msb_doctor_ok, text: 'sandbox runtime' },
    { ok: h.runner?.firewall?.available, text: `firewall, ${h.runner?.firewall?.rules ?? 0} rules` },
    { ok: h.s3, text: 'evidence store' },
    { ok: h.inference_base_is_vultr, text: `Vultr inference, ${h.planner_model ?? 'no model'}` },
  ];
  return (
    <footer className="statusbar">
      <span className="statusbar-title">System</span>
      {items.map((i) => (
        // Quiet while everything is up. A mark and colour appear only for something that is down.
        <span className={i.ok ? 'statusbar-item' : 'statusbar-item is-down'} key={i.text}>
          {!i.ok && <Mark tone="bad" size={11} />}
          {i.text}
          {!i.ok && <span className="sr-only"> is down</span>}
        </span>
      ))}
      {h.runner_error && <span className="statusbar-item is-down">runner error: {h.runner_error}</span>}
    </footer>
  );
}
