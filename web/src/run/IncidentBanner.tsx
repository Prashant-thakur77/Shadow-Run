import type { IncidentRef } from '../api/types';
import { Link } from '../lib/router';

export function IncidentBanner({ incident }: { incident: IncidentRef }) {
  return (
    <aside className="incident-banner" aria-label="The real incident behind this run">
      <div className="incident-banner-head">
        <span className="label">Real incident, replayed on a clone</span>
        <span className="incident-who">
          {incident.who}
          {incident.when && <span className="muted">, {incident.when}</span>}
        </span>
      </div>
      {incident.happened && <p className="incident-happened">{incident.happened}</p>}
      {incident.adapted && <p className="incident-adapted">{incident.adapted}</p>}
      <p className="incident-links">
        {incident.source && (
          <a href={incident.source} target="_blank" rel="noreferrer">
            The source
          </a>
        )}
        <Link href="/incidents">All replayed incidents</Link>
      </p>
    </aside>
  );
}
