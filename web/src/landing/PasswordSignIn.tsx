import { useState, type FormEvent } from 'react';
import { errorText } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const ACCOUNTS = [
  { username: 'judge', role: 'Maker', what: 'Requests changes.' },
  { username: 'reviewer', role: 'Checker', what: 'Approves changes.' },
];

export function PasswordSignIn() {
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
