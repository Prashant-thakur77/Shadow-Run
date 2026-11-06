import { useCallback, useState } from 'react';

type Theme = 'dark' | 'light';

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('sr.theme', next);
      } catch {
        // Private windows may refuse storage. The toggle still works for this page.
      }
      return next;
    });
  }, []);
  return [theme, toggle];
}
