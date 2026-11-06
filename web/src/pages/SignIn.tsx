import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api/client';
import type { PublicInfo } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { num, whenAny } from '../lib/format';
import { Link } from '../lib/router';
import { useTheme } from '../lib/theme';
import { useAsync } from '../lib/useAsync';
import { Fold, Loading } from '../ui/bits';

const ACCOUNTS = [
  { username: 'judge', role: 'Maker', what: 'Requests changes.' },
  { username: 'reviewer', role: 'Checker', what: 'Approves changes.' },
];

function PasswordSignIn() {
  const { signIn } = useAuth();
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (username: string) => {
    const password = passwords[username];
    if (!password) {
      setError(`Type the password for ${username} first.`);
      return;
    }
    const other = ACCOUNTS.find((a) => a.username !== username)!;
    const otherPassword = passwords[other.username];
    setBusy(username);
    setError(null);
    try {
      await signIn(username, password, otherPassword ? { username: other.username, password: otherPassword } : null);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const first = ACCOUNTS.find((a) => passwords[a.username]);
    void submit(first?.username ?? 'judge');
  };

  return (
    <form className="signin-form" onSubmit={onSubmit}>
      <p className="signin-why">There are two accounts because the person who requests a change can't approve it.</p>
      <div className="account-list">
        {ACCOUNTS.map((a) => (
          <div className="account" key={a.username}>
            <div className="account-who">
              <span className="account-name mono">{a.username}</span>
              <span className="account-role">
                {a.role}. {a.what}
              </span>
            </div>
            <label className="account-pass">
              <span className="sr-only">Password for {a.username}</span>
              <input
                className="input mono"
                type="password"
                placeholder="Password"
                autoComplete="off"
                value={passwords[a.username] ?? ''}
                onChange={(e) => setPasswords((p) => ({ ...p, [a.username]: e.target.value }))}
              />
            </label>
            <button type="button" className="btn" disabled={!!busy} onClick={() => void submit(a.username)}>
              {busy === a.username ? 'Signing in' : `Sign in as ${a.username}`}
            </button>
          </div>
        ))}
      </div>
      {/* Lets Enter submit from either field. */}
      <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
        Sign in
      </button>
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
      <p className="muted signin-note">On the public demo, use Continue as guest. Passwords are for deployments that set them. This tab keeps a session token for each account, never the password, and forgets them when it closes.</p>
    </form>
  );
}

/** Every number here comes from the benchmark's own file. Before it has run, nothing is shown. */
function Headline({ data, loading }: { data: PublicInfo | null; loading: boolean }) {
  if (loading && !data) return <Loading>Reading the measurements</Loading>;
  const h = data?.headline;
  if (!h) {
    return (
      <section className="land-notyet" aria-label="Benchmark headline">
        <div className="land-notyet-word">Not measured yet</div>
        <p>The benchmark has not finished on this build, so there is no number to show here. Nothing is estimated.</p>
      </section>
    );
  }
  const cells: { label: string; value?: number; strong?: boolean }[] = [
    { label: 'Agent directly', value: h.direct },
    { label: 'Static gate', value: h.static_gate },
    { label: 'Shadow Run', value: h.shadow_run, strong: true },
    { label: 'Shadow Run, if a person rubber-stamps everything it holds', value: h.rubber_stamp },
  ];
  return (
    <section className="land-headline" aria-label="Benchmark headline">
      <h2 className="land-headline-title">
        Harmful outcomes on prod, of <span className="mono">{num(h.risky_tasks)}</span> risky tasks held out from tuning
      </h2>
      <dl className="land-numbers">
        {cells.map((c) => {
          const tone = c.value === 0 ? 'good' : 'bad';
          return (
            <div className={`land-number is-${tone}${c.strong ? ' is-strong' : ''}`} key={c.label}>
              <dd className="mono land-number-value">{num(c.value)}</dd>
              <dt>{c.label}</dt>
            </div>
          );
        })}
      </dl>
      <p className="muted land-headline-foot">
        Mean of <span className="mono">{num(h.runs_per_task)}</span> runs per task. Measured <span className="mono">{whenAny(h.measured_at)}</span>. <Link href="/results">All results</Link>
      </p>
    </section>
  );
}

export function SignInPage() {
  const { enterAsGuest } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const info = useAsync<PublicInfo>(() => api.publicInfo());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const guestOff = info.data?.open_demo === false;

  const enter = async () => {
    setBusy(true);
    setError(null);
    try {
      await enterAsGuest();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="landing">
      <div className="landing-inner">
        <div className="signin-brand">
          <span className="wordmark">
            <span className="wordmark-mark" aria-hidden="true" />
            <span>Shadow Run</span>
          </span>
          <button type="button" className="textbtn" onClick={toggleTheme}>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>

        <h1 className="landing-claim">Your agent wants to touch prod. Shadow Run lets it break a clone first.</h1>

        <div className="landing-cta">
          {!guestOff && (
            <button type="button" className="btn btn-primary btn-guest" disabled={busy} onClick={enter}>
              {busy ? 'Entering' : 'Continue as guest'}
            </button>
          )}
          <p className="landing-cta-note">
            {guestOff
              ? 'This deployment has no open demo. Sign in with a password below.'
              : 'No password. You get both people, the one who requests a change and the one who approves it, so you can run the whole flow in this tab. In a real deployment those are two different people.'}
          </p>
        </div>
        {error && (
          <p className="error-line" role="alert">
            {error}
          </p>
        )}

        <Headline data={info.data} loading={info.loading} />

        <ul className="landing-links">
          {info.data?.video_url && (
            <li>
              <a href={info.data.video_url} target="_blank" rel="noreferrer">
                Watch the video
              </a>
            </li>
          )}
          {info.data?.repo && (
            <li>
              <a href={info.data.repo} target="_blank" rel="noreferrer">
                The code
              </a>
            </li>
          )}
          <li>
            <Link href="/incidents">Real incidents, replayed</Link>
          </li>
          <li>
            <Link href="/receipts">Receipts</Link>
          </li>
          <li>
            <Link href="/results">Results</Link>
          </li>
        </ul>

        <Fold summary="Sign in with a password" open={guestOff}>
          <PasswordSignIn />
        </Fold>
      </div>
    </div>
  );
}
