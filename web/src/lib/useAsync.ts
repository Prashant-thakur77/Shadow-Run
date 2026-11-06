import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '../api/client';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  set: (v: T) => void;
}

/** Load once when `key` changes. Keeps the last good data if a reload fails. */
export function useAsync<T>(fn: () => Promise<T>, key: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    fnRef
      .current()
      .then((v) => {
        if (stopped) return;
        setData(v);
        setError(null);
      })
      .catch((e) => {
        if (!stopped) setError(errorText(e));
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...key]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, set: setData };
}
