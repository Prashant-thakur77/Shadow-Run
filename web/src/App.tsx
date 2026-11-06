import { useEffect, useRef, useState } from 'react';
import { api, errorText } from './api/client';
import type { Health, ProdChecksum } from './api/types';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { short } from './lib/format';
import { currentTarget } from './lib/target';
import { Link, RouterProvider, useLocation } from './lib/router';
import { useTheme } from './lib/theme';
import { useAsync } from './lib/useAsync';
import { AuditPage } from './pages/Audit';
import { HomePage } from './pages/Home';
import { RedTeamPage } from './pages/RedTeam';
import { ResultsPage } from './pages/Results';
import { RunPage } from './pages/RunPage';
import { SignInPage } from './pages/SignIn';
import { TargetPage } from './pages/Target';
import { Boundary, Loading, Mark } from './ui/bits';

export function App() {
  return (
    <RouterProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </RouterProvider>
  );
}

function Shell() {
  const { user, ready } = useAuth();
  const { path } = useLocation();
  const runMatch = path.match(/^\/runs\/([^/]+)\/?$/);

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

  // Results are public, like the README table. Everything else needs an account.
  if (!user && path !== '/results') return <SignInPage />;

  let page = <NotFound />;
  if (path === '/') page = <HomePage />;
  else if (runMatch) page = <RunPage key={runMatch[1]} id={decodeURIComponent(runMatch[1])} />;
  else if (path === '/redteam') page = <RedTeamPage />;
  else if (path === '/guardrails') page = <TargetPage />;
  else if (path === '/results') page = <ResultsPage />;
  else if (path === '/audit') page = <AuditPage />;

  return (
    <div className="app">
      <Header />
      <main className="main">
        <Boundary key={path} label="page">
          {page}
        </Boundary>
      </main>
      <StatusBar />
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
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
  { href: '/results', label: 'Results' },
  { href: '/audit', label: 'Audit' },
];

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-mark" aria-hidden="true" />
      <span>Shadow Run</span>
    </span>
  );
}

function Header() {
  const { path } = useLocation();
  const { user, signOut } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const active = (href: string) => (href === '/' ? path === '/' || path.startsWith('/runs/') : path === href);
  return (
    <header className="topbar">
      <div className="topbar-row">
        <Link href="/" className="brand" aria-label="Shadow Run, new task">
          <Wordmark />
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={active(n.href) ? 'nav-link is-active' : 'nav-link'} aria-current={active(n.href) ? 'page' : undefined}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          {user && <ProdIndicator />}
          {user ? <IdentitySwitch /> : <Link href="/" className="btn btn-small">Sign in</Link>}
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
    </header>
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
        <span className="statusbar-item" key={i.text}>
          <Mark tone={i.ok ? 'good' : 'bad'} size={11} />
          {i.text}
        </span>
      ))}
      {h.runner_error && <span className="statusbar-item">runner error: {h.runner_error}</span>}
    </footer>
  );
}
