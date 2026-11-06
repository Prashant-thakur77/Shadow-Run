import { createContext, useContext, useEffect, useMemo, useState, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

interface Loc {
  path: string;
  search: string;
}

const RouterContext = createContext<Loc>({ path: '/', search: '' });

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const change = () => {
    if (opts.replace) history.replaceState(null, '', to);
    else history.pushState(null, '', to);
    window.dispatchEvent(new Event('sr:navigate'));
    // Instant, because a page that is changing should not also be scrolling.
    if (!to.includes('#')) window.scrollTo({ top: 0, behavior: 'instant' });
  };
  // Browsers without the API change routes with no animation. So does anyone who has asked for less motion.
  if (typeof document.startViewTransition === 'function' && !reducedMotion()) {
    document.startViewTransition(async () => {
      flushSync(change);
      // A lazily loaded page commits a tick after its promise resolves, and a shared element needs to be there by then.
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  } else {
    change();
  }
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
