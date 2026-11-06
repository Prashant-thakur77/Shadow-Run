import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorText } from '../api/client';
import type { Run } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { pollDelay } from '../lib/status';

/** Polls about once a second while a run moves, more slowly while it waits on a person, and stops once it is finished. */
export function useRun(id: string) {
  const { version } = useAuth();
  const [run, setRunState] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [kick, setKick] = useState(0);
  const fast = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      let delay: number | null = 3000;
      try {
        const next = await api.run(id);
        if (stopped) return;
        setRunState(next);
        setError(null);
        delay = pollDelay(next.status, fast.current);
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 404) {
          setNotFound(true);
          delay = null;
        } else {
          setError(errorText(e));
        }
      }
      if (delay !== null) timer = window.setTimeout(tick, delay);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [id, version, kick]);

  /** Use the run an API call just returned, and restart polling from there. */
  const setRun = useCallback((next: Run) => {
    setRunState(next);
    setKick((k) => k + 1);
  }, []);

  const pollFast = useCallback((on: boolean) => {
    fast.current = on;
    if (on) setKick((k) => k + 1);
  }, []);

  return { run, error, notFound, setRun, pollFast };
}
