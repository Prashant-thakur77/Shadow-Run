import { useCallback, useState, type RefObject } from 'react';
import { STACKED, useMedia, useReducedMotion } from '../lib/media';
import { num } from '../lib/format';
import { sourceLine } from '../ui/Figure';
import { PrimaryButton } from '../ui/Halftone';
import { ReplayControls, TwoRooms, TwoRoomsEmpty, useRehearsal } from '../ui/TwoRooms';
import { useLanding } from './context';
import { LiveStrip } from './LiveStrip';

const preloadHome = () => void import('../pages/Home');

export function Hero({ ctaRef, ctaOffscreen }: { ctaRef: RefObject<HTMLButtonElement>; ctaOffscreen: boolean }) {
  const { info, loading, guestOff, busy, error, enter } = useLanding();
  const reduced = useReducedMotion();
  const stacked = useMedia(STACKED);
  const hero = info?.hero ?? null;
  const h = info?.headline ?? null;
  const control = useRehearsal(hero, { reduced });
  const [scale, setScale] = useState<string | null>(null);
  const onScale = useCallback((s: string) => setScale(s), []);
  const { script } = control;

  return (
    <section className="hero" aria-labelledby="hero-title">
      <h1 className="t-display-xl hero-title" id="hero-title">
        <span className="hero-line hero-line-1">Your agent wants to touch prod.</span>{' '}
        <span className="hero-line hero-line-2">
          Shadow Run lets it break a <span className="t-outline">clone</span> first.
        </span>
      </h1>

      <LiveStrip />

      <figure className="hero-stage">
        {/* The hero is always a replay of a database incident, and a database clone has no network device. */}
        {hero ? <TwoRooms control={control} hero={hero} phone={stacked} seeded network="no network card" verdicts sourceLine={onScale} /> : <TwoRoomsEmpty loading={loading} />}
      </figure>

      <div className="hero-bar">
        <div className="hero-bar-side">
          {!guestOff && (
            <PrimaryButton type="button" className="btn-large hero-race" ref={ctaRef} disabled={busy} onClick={() => void enter('/race')} style={{ visibility: ctaOffscreen ? 'hidden' : 'visible' }}>
              {busy ? 'Entering' : 'Race the agent'}
            </PrimaryButton>
          )}
          {!guestOff && (
            <button type="button" className="btn btn-large" disabled={busy} onClick={() => void enter()} onFocus={preloadHome} onMouseOver={preloadHome} title="No password. You play both the requester and the approver.">
              Continue as guest
            </button>
          )}
          <p className="hero-note">
            {guestOff ? (
              <>
                This deployment has no open demo. <a href="#sign-in">Sign in with a password</a>.
              </>
            ) : h && typeof h.shadow_run === 'number' && typeof h.direct === 'number' ? (
              <span className="hero-numbers">
                <span>
                  <b className={`mono ${h.shadow_run === 0 ? 'is-good' : 'is-bad'}`}>
                    {num(h.shadow_run)} of {num(h.risky_tasks)}
                  </b>{' '}
                  held-out risky tasks did harm before a person saw the plan.
                </span>{' '}
                <span>
                  The agent alone did harm on <b className="mono is-bad">{num(h.direct)}</b>, through Shadow Run with every plan approved unread <b className="mono">{num(h.rubber_stamp)}</b>, {h.runs_per_task ? `each the mean of ${num(h.runs_per_task)} runs.` : 'each a mean over runs.'}
                </span>{' '}
                <a href="#results">How it was measured</a>
              </span>
            ) : (
              'No password. You play both the requester and the approver.'
            )}
            {info?.video_url && (
              <>
                {' '}
                <a href={info.video_url} target="_blank" rel="noreferrer">
                  Watch the video
                </a>
                .
              </>
            )}
          </p>
          {error && (
            <p className="error-line" role="alert">
              {error}
            </p>
          )}
        </div>
        {hero && (
          <div className="hero-bar-side hero-bar-controls">
            <ReplayControls control={control} reduced={reduced} />
            {!guestOff && (
              <button type="button" className="btn" disabled={busy} onClick={() => void enter(`/runs/${encodeURIComponent(hero.run_id)}`)}>
                Open this run
              </button>
            )}
          </div>
        )}
      </div>

      {hero && (
        <p className="t-caption hero-caption">
          {sourceLine({ n: 1, run: hero.run_id, measured: hero.measured_at, scale, extra: script && script.factor > 1 ? `compressed ×${script.factor.toFixed(1)}` : null })}
          {' · '}
          {reduced ? 'Replay of this run at its measured phase lengths.' : 'Replay of this run at real speed. Phase lengths are measured.'} A time with + is from the start of the run; one without is how long that step took. Order inside a phase follows the foreign keys, not a clock.
          {hero.incident.who && (
            <>
              {' '}
              The command replays {hero.incident.who}
              {hero.incident.when ? `, ${hero.incident.when}` : ''}
              {hero.incident.source && (
                <>
                  {' '}
                  (
                  <a href={hero.incident.source} target="_blank" rel="noreferrer">
                    source
                  </a>
                  )
                </>
              )}
              .
            </>
          )}
        </p>
      )}
    </section>
  );
}
