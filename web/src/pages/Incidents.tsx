import { useState } from 'react';
import { api, errorText } from '../api/client';
import type { Incident } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { Loading, Notice } from '../ui/bits';

function IncidentCard({ incident }: { incident: Incident }) {
  const { user, enterAsGuest } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replay = async () => {
    setBusy(true);
    setError(null);
    try {
      // Reading is public. Running something needs an identity, and the open demo gives one.
      if (!user) await enterAsGuest();
      const res = await api.replayIncident(incident.id);
      navigate(`/runs/${encodeURIComponent(res.id)}`);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <li className="incident">
      <div className="incident-head">
        <h2 className="incident-title">{incident.who}</h2>
        <span className="mono muted incident-when">{incident.when}</span>
      </div>
      <p className="incident-what">{incident.happened}</p>
      <pre className="sql incident-command">{incident.command}</pre>
      {incident.adapted && <p className="incident-adapted">{incident.adapted}</p>}
      <div className="incident-foot">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={replay}>
          {busy ? 'Starting' : 'Replay on a clone'}
        </button>
        {incident.source && (
          <a href={incident.source} target="_blank" rel="noreferrer">
            The source
          </a>
        )}
        <span className="muted mono incident-target">{incident.target}</span>
      </div>
      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

export function IncidentsPage() {
  const incidents = useAsync<Incident[]>(() => api.incidents());
  return (
    <div className="page incidents">
      <h1 className="page-title">Real incidents, replayed</h1>
      <p className="page-lead">Each of these happened to someone. Replaying one runs the same kind of command on a disposable clone, and measures what it would have done.</p>
      {incidents.error && <Notice tone="bad" title="Could not load the incidents.">{incidents.error}</Notice>}
      {!incidents.data && !incidents.error && <Loading />}
      {incidents.data?.length === 0 && <p className="notmeasured">No incidents are listed.</p>}
      {(incidents.data?.length ?? 0) > 0 && (
        <ol className="incident-list">
          {incidents.data?.map((i) => (
            <IncidentCard key={i.id} incident={i} />
          ))}
        </ol>
      )}
    </div>
  );
}
