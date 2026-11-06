import { Link } from '../../lib/router';
import { Fold } from '../../ui/bits';
import { PrimaryButton } from '../../ui/Halftone';
import { useLanding } from '../context';
import { PasswordSignIn } from '../PasswordSignIn';

export function Close() {
  const { info, guestOff, busy, error, enter } = useLanding();
  return (
    <section className="ch ch-close" aria-labelledby="close-title">
      <div className="ch-inner close-grid">
        <div className="close-cta">
          <h2 className="t-display-l" id="close-title">
            Break a clone yourself.
          </h2>
          {!guestOff && (
            <PrimaryButton type="button" className="btn-huge" disabled={busy} onClick={() => void enter()}>
              {busy ? 'Entering' : 'Enter as guest'}
            </PrimaryButton>
          )}
          <p className="close-note">
            {guestOff
              ? 'This deployment has no open demo. Sign in with a password below.'
              : 'No password. You get both people, the one who requests a change and the one who approves it, so you can run the whole flow in this tab. In a real deployment those are two different people.'}
          </p>
          {error && (
            <p className="error-line" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="close-side">
          <ul className="close-links">
            {info?.video_url && (
              <li>
                <a href={info.video_url} target="_blank" rel="noreferrer">
                  Watch the video
                </a>
              </li>
            )}
            {info?.repo && (
              <li>
                <a href={info.repo} target="_blank" rel="noreferrer">
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
          <div id="sign-in">
            <Fold summary="Sign in with a password" open={guestOff}>
              <PasswordSignIn />
            </Fold>
          </div>
        </div>
      </div>
      <div className="close-mark" aria-hidden="true">
        <span className="t-outline">Shadow Run</span>
      </div>
    </section>
  );
}
