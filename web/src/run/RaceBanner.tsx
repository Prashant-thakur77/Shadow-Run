import type { Run } from '../api/types';
import { short } from '../lib/format';
import { Link } from '../lib/router';

export function RaceBanner({ race }: { race: NonNullable<Run['race']> }) {
  return (
    <aside className="incident-banner" aria-label="The race this run belongs to">
      <div className="incident-banner-head">
        <span className="label">One lane of a race</span>
        <span className="incident-who">{race.lane === 'alone' ? 'The agent alone' : 'Through Shadow Run'}</span>
      </div>
      <p className="incident-happened">
        {race.lane === 'alone' ? "The agent's first plan, with no feedback and no retry, measured on a clone. It can't be approved or applied." : 'The normal pipeline, rehearse only. The server refuses to approve or apply it.'} Nothing from a race can reach prod.
      </p>
      <p className="incident-links">
        <Link href={`/race?id=${encodeURIComponent(race.id)}`}>Back to the race</Link>
      </p>
    </aside>
  );
}

/** A normal run of the plan a race ended on. It says so, and whether the hash still matches. */
export function RaceOriginBanner({ run }: { run: Run }) {
  const from = run.from_race;
  if (!from) return null;
  const frozen = run.plan_hash ?? run.final?.plan_hash;
  return (
    <aside className="incident-banner" aria-label="The race this plan came from">
      <div className="incident-banner-head">
        <span className="label">From a race</span>
        <span className="incident-who">The plan the right lane ended on</span>
      </div>
      <p className="incident-happened">
        {frozen && frozen === from.plan_hash ? (
          <>
            Same plan hash as the race, <code className="mono">{short(from.plan_hash, 12)}</code>.
          </>
        ) : (
          <>
            The race's plan hash is <code className="mono">{short(from.plan_hash, 12)}</code>.
          </>
        )}{' '}
        A rehearsal only holds for the prod it measured, so this run rehearses it again. Unlike a race, this run can reach prod, once a different person approves it.
      </p>
      <p className="incident-links">
        <Link href={`/race?id=${encodeURIComponent(from.id)}`}>Back to the race</Link>
      </p>
    </aside>
  );
}
