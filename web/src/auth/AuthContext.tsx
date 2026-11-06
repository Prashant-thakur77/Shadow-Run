import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, api, errorText, setBearer, setUnauthorizedHandler } from '../api/client';
import type { Me } from '../api/types';

// Tokens live in sessionStorage: this tab only, gone when the tab closes. Passwords are never stored.
const KEY = 'sr.session';

interface Stored {
  active: string | null;
  tokens: Record<string, string>;
}

function load(): Stored {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Stored>;
      return { active: parsed.active ?? null, tokens: parsed.tokens ?? {} };
    }
  } catch {
    // Storage may be blocked. The session then lasts until reload.
  }
  return { active: null, tokens: {} };
}

function save(s: Stored) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Same as above.
  }
}

interface AuthValue {
  user: Me | null;
  ready: boolean;
  /** Bumps on every identity change, so views refetch what the server computes per user. */
  version: number;
  knownUsers: string[];
  signIn: (username: string, password: string, also?: { username: string; password: string } | null) => Promise<void>;
  /** The open demo: signs in as judge and keeps the reviewer token, so every switch is one click. */
  enterAsGuest: () => Promise<void>;
  signOut: () => Promise<void>;
  /** One click when the token is already known. Otherwise asks for the password once. */
  switchTo: (username: string) => Promise<boolean>;
  /** A token for this account, asking for its password if needed. Null if the person cancels. */
  tokenFor: (username: string) => Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

interface PromptState {
  username: string;
  resolve: (token: string | null) => void;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const store = useRef<Stored>(load());
  const [user, setUser] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState(0);
  const [known, setKnown] = useState<string[]>(Object.keys(store.current.tokens));
  const [prompt, setPrompt] = useState<PromptState | null>(null);

  const persist = useCallback(() => {
    save(store.current);
    setKnown(Object.keys(store.current.tokens));
  }, []);

  const forget = useCallback(
    (username: string | null) => {
      if (username) delete store.current.tokens[username];
      if (username === store.current.active || username === null) store.current.active = null;
      setBearer(null);
      persist();
      setUser(null);
    },
    [persist],
  );

  // First load: this tab's token if it has one, otherwise the login cookie.
  useEffect(() => {
    let stopped = false;
    const { active, tokens } = store.current;
    const token = active ? (tokens[active] ?? null) : null;
    setBearer(token);
    api
      .me(token)
      .then((me) => {
        if (stopped) return;
        if (me.token) store.current.tokens[me.username] = me.token;
        store.current.active = me.username;
        setBearer(store.current.tokens[me.username] ?? token);
        persist();
        setUser(me);
      })
      .catch((e) => {
        if (stopped) return;
        // A network blip should not throw away a good token.
        if (e instanceof ApiError && e.status === 401) forget(active);
      })
      .finally(() => {
        if (!stopped) setReady(true);
      });
    return () => {
      stopped = true;
    };
  }, [forget, persist]);

  useEffect(() => {
    setUnauthorizedHandler(() => forget(store.current.active));
    return () => setUnauthorizedHandler(null);
  }, [forget]);

  const activate = useCallback(
    (me: Me, token: string) => {
      store.current.tokens[me.username] = token;
      store.current.active = me.username;
      setBearer(token);
      persist();
      setUser(me);
      setVersion((v) => v + 1);
    },
    [persist],
  );

  const signIn = useCallback<AuthValue['signIn']>(
    async (username, password, also) => {
      if (also) {
        // Best effort: having both tokens makes the first switch one click. A wrong second password
        // only means that account asks again when it is first needed. This goes first so the login
        // cookie, which a new tab starts from, belongs to the account chosen below.
        try {
          const other = await api.login(also.username, also.password);
          store.current.tokens[also.username] = other.token;
        } catch {
          delete store.current.tokens[also.username];
        }
      }
      const res = await api.login(username, password);
      const me = await api.me(res.token);
      activate(me, res.token);
    },
    [activate],
  );

  const enterAsGuest = useCallback(async () => {
    const res = await api.demoEnter();
    for (const [name, token] of Object.entries(res.others ?? {})) store.current.tokens[name] = token;
    const me = await api.me(res.token);
    activate(me, res.token);
  }, [activate]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The local session is cleared either way.
    }
    store.current = { active: null, tokens: {} };
    setBearer(null);
    persist();
    setUser(null);
    setVersion((v) => v + 1);
  }, [persist]);

  const tokenFor = useCallback<AuthValue['tokenFor']>(async (username) => {
    const existing = store.current.tokens[username];
    if (existing) {
      try {
        await api.me(existing);
        return existing;
      } catch {
        delete store.current.tokens[username];
      }
    }
    // On the open demo the server hands out both identities, so nobody has to type anything.
    try {
      const res = await api.demoEnter();
      const tokens: Record<string, string> = { [res.username]: res.token, ...(res.others ?? {}) };
      Object.assign(store.current.tokens, tokens);
      save(store.current);
      setKnown(Object.keys(store.current.tokens));
      if (tokens[username]) return tokens[username];
    } catch {
      // No open demo on this deployment. Ask for the password.
    }
    return new Promise<string | null>((resolve) => setPrompt({ username, resolve }));
  }, []);

  const switchTo = useCallback<AuthValue['switchTo']>(
    async (username) => {
      const token = await tokenFor(username);
      if (!token) return false;
      const me = await api.me(token);
      activate(me, token);
      return true;
    },
    [activate, tokenFor],
  );

  const value = useMemo<AuthValue>(
    () => ({ user, ready, version, knownUsers: known, signIn, enterAsGuest, signOut, switchTo, tokenFor }),
    [user, ready, version, known, signIn, enterAsGuest, signOut, switchTo, tokenFor],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {prompt && (
        <PasswordDialog
          username={prompt.username}
          onDone={(token) => {
            if (token) {
              store.current.tokens[prompt.username] = token;
              persist();
            }
            prompt.resolve(token);
            setPrompt(null);
          }}
        />
      )}
    </AuthContext.Provider>
  );
}

function PasswordDialog({ username, onDone }: { username: string; onDone: (token: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(username, password);
      onDone(res.token);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onCancel={() => onDone(null)}>
      <form onSubmit={submit}>
        <h2 className="dialog-title">Password for {username}</h2>
        <p className="muted">Passwords are for deployments that set them. On the public demo, use Continue as guest. You only type it once in this tab.</p>
        <label className="field">
          <span className="field-label">Password</span>
          <input
            className="input mono"
            type="password"
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error-line" role="alert">{error}</p>}
        <div className="row gap-s dialog-actions">
          <button className="btn btn-primary" type="submit" disabled={busy || !password}>
            {busy ? 'Signing in' : `Continue as ${username}`}
          </button>
          <button className="btn" type="button" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
