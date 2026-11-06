import { createContext, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

interface Loc {
  path: string;
  search: string;
}

const RouterContext = createContext<Loc>({ path: '/', search: '' });

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  window.dispatchEvent(new Event('sr:navigate'));
  if (!to.includes('#')) window.scrollTo(0, 0);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState<Loc>({ path: location.pathname, search: location.search });
  useEffect(() => {
    const update = () => setLoc({ path: location.pathname, search: location.search });
    window.addEventListener('popstate', update);
    window.addEventListener('sr:navigate', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('sr:navigate', update);
    };
  }, []);
  const value = useMemo(() => loc, [loc]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export const useLocation = () => useContext(RouterContext);

export function Link({ href, onClick, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
