import { createContext, useContext } from 'react';
import type { PublicInfo } from '../api/types';

export interface LandingValue {
  info: PublicInfo | null;
  loading: boolean;
  /** This deployment has no open demo, so guests can't come in. */
  guestOff: boolean;
  busy: boolean;
  error: string | null;
  /** Comes in as a guest, then goes to `to` if given. */
  enter: (to?: string) => Promise<void>;
}

export const LandingContext = createContext<LandingValue | null>(null);

export function useLanding(): LandingValue {
  const v = useContext(LandingContext);
  if (!v) throw new Error('useLanding outside the landing page');
  return v;
}
