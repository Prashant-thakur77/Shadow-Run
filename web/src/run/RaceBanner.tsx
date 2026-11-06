import type { Run } from '../api/types';
import { Link } from '../lib/router';

export function RaceBanner({ race }: { race: NonNullable<Run['race']> }) {
  return (
    <aside className="incident-banner" aria-label="The race this run belongs to">
      <div className="incident-banner-head">
        <span className="label">One lane of a race</span>
        <span className="incident-who">{race.lane === 'alone' ? 'The agent alone' : 'Through Shadow Run'}</span>
      </div>
      <p className="incident-happened">
        {race.lane === 'alone' ? "The agent's first plan, with no feedback and no retry, measured on a clone. It stays refused." : 'The normal pipeline, rehearse only. The server refuses to approve or apply it.'} Nothing from a race can reach prod.
      </p>
      <p className="incident-links">
        <Link href={`/race?id=${encodeURIComponent(race.id)}`}>Back to the race</Link>
      </p>
    </aside>
  );
}
