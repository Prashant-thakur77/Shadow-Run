import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorText } from './api/client';
import type { Health, ProdChecksum } from './api/types';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { short } from './lib/format';
import { Link, RouterProvider, useLocation } from './lib/router';
import { currentTarget } from './lib/target';
import { useTheme } from './lib/theme';
import { useAsync } from './lib/useAsync';
import { SignInPage } from './pages/SignIn';
import { Boundary, Loading, Mark } from './ui/bits';

// The landing page ships in the main chunk. Everything behind it loads when it is needed, so the first visit
// doesn't download the authenticated pages.
const load = {
  home: () => import('./pages/Home'),
  run: () => import('./pages/RunPage'),
  redteam: () => import('./pages/RedTeam'),
  target: () => import('./pages/Target'),
  incidents: () => import('./pages/Incidents'),
  receipts: () => import('./pages/Receipts'),
  results: () => import('./pages/Results'),
  audit: () => import('./pages/Audit'),
};
const HomePage = lazy(() => load.home().then((m) => ({ default: m.HomePage })));
const RunPage = lazy(() => load.run().then((m) => ({ default: m.RunPage })));
const RedTeamPage = lazy(() => load.redteam().then((m) => ({ default: m.RedTeamPage })));
const TargetPage = lazy(() => load.target().then((m) => ({ default: m.TargetPage })));
const IncidentsPage = lazy(() => load.incidents().then((m) => ({ default: m.IncidentsPage })));
const ReceiptsPage = lazy(() => load.receipts().then((m) => ({ default: m.ReceiptsPage })));
const ResultsPage = lazy(() => load.results().then((m) => ({ default: m.ResultsPage })));
const AuditPage = lazy(() => load.audit().then((m) => ({ default: m.AuditPage })));

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
  return (
    <RouterProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </RouterProvider>
  );
}

const PUBLIC_PATHS = ['/results', '/incidents', '/receipts'];

function Shell() {
  const { user, ready } = useAuth();
  const { path } = useLocation();
  const runMatch = path.match(/^\/runs\/([^/]+)\/?$/);
  usePreloadPages(!!user);

  useEffect(() => {
    const base = 'Shadow Run';
    document.title = runMatch ? `Run ${decodeURIComponent(runMatch[1])} · ${base}` : base;
  }, [runMatch?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return (
      <div className="boot">
        <Loading>Checking who you are</Loading>
      </div>
    );
  }

  // Evidence is public, like the README. Everything else starts at the landing page.
  if (!user && !PUBLIC_PATHS.includes(path)) return <SignInPage />;

  let page = <NotFound />;
  if (path === '/') page = <HomePage />;
  else if (runMatch) page = <RunPage key={runMatch[1]} id={decodeURIComponent(runMatch[1])} />;
  else if (path === '/redteam') page = <RedTeamPage />;
  else if (path === '/guardrails') page = <TargetPage />;
  else if (path === '/incidents') page = <IncidentsPage />;
  else if (path === '/receipts') page = <ReceiptsPage />;
  else if (path === '/results') page = <ResultsPage />;
  else if (path === '/audit') page = <AuditPage />;

  return (
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
            {page}
          </Suspense>
        </Boundary>
      </main>
      <StatusBar />
      <BottomBar />
    </div>
  );
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
  { href: '/redteam', label: 'Red team' },
  { href: '/guardrails', label: 'Guardrails' },
  { href: '/incidents', label: 'Incidents' },
  { href: '/receipts', label: 'Receipts' },
  { href: '/results', label: 'Results' },
  { href: '/audit', label: 'Audit' },
];

function useIsActive() {
  const { path } = useLocation();
  return (href: string) => (href === '/' ? path === '/' || path.startsWith('/runs/') : path === href);
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
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
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
              <Link href="/" className="btn btn-small">
                Enter the demo
              </Link>
            )}
            <button type="button" className="textbtn" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            {user && (
              <button type="button" className="textbtn" onClick={() => void signOut()}>
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
  const sheet = useRef<HTMLDialogElement>(null);
  const items = user ? NAV.filter((n) => ['/', '/redteam', '/incidents', '/receipts'].includes(n.href)) : [{ href: '/', label: 'Enter' }, ...NAV.filter((n) => ['/incidents', '/receipts', '/results'].includes(n.href))];
  const rest = user ? NAV.filter((n) => !items.some((i) => i.href === n.href)) : [];

  useEffect(() => {
    sheet.current?.close();
  }, [path]);

  return (
    <>
      <nav className="bottombar" aria-label="Main, phone">
        {items.map((n) => (
          <Link key={n.href} href={n.href} className={isActive(n.href) ? 'bottombar-link is-active' : 'bottombar-link'} aria-current={isActive(n.href) ? 'page' : undefined}>
            {n.label}
          </Link>
        ))}
        {user && (
          <button type="button" className="bottombar-link" onClick={() => sheet.current?.showModal()}>
            More
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
              <button type="button" className="btn" onClick={() => void signOut()}>
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

function ProdIndicator() {
  const [data, setData] = useState<ProdChecksum | null>(null);
  const [failed, setFailed] = useState(false);
  const [changed, setChanged] = useState(false);
  const last = useRef<string | undefined>(undefined);
  const lastTarget = useRef<string | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let flash: number | undefined;
    const measure = async () => {
      try {
        const target = currentTarget();
        const res = await api.prodChecksum(target);
        if (stopped || target !== currentTarget()) return;
        setFailed(false);
        setData(res);
        // Moving to another target is not a change to prod.
        const sameTarget = lastTarget.current === target;
        lastTarget.current = target;
        if (sameTarget && last.current && res.digest && res.digest !== last.current) {
          setChanged(true);
          window.clearTimeout(flash);
          flash = window.setTimeout(() => setChanged(false), 6000);
        }
        last.current = res.digest;
      } catch {
        if (!stopped) setFailed(true);
      }
    };
    void measure();
    const timer = window.setInterval(measure, 15000);
    window.addEventListener('sr:prod-changed', measure);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(flash);
      window.removeEventListener('sr:prod-changed', measure);
    };
  }, []);

  return (
    <span
      className={changed ? 'prod is-changed' : 'prod'}
      title={data?.digest ? `Prod checksum ${data.digest}, LSN ${data.lsn ?? 'unknown'}. Measured from the control plane.` : undefined}
    >
      <span className="prod-label">{data?.files !== undefined ? 'Prod server' : 'Prod'}</span>
      <code className="mono prod-hash">{failed ? 'unavailable' : data?.digest ? short(data.digest, 8).replace('…', '') : '…'}</code>
      {changed && <span className="prod-changed">changed</span>}
    </span>
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
