import { api } from '../../api/client';
import type { Incident, Receipt } from '../../api/types';
import { useAsync } from '../../lib/useAsync';
import { useLanding } from '../context';
import '../chapters.css';
import { Blueprint } from './Blueprint';
import { Close } from './Close';
import { HasHappened } from './HasHappened';
import { Results } from './Results';
import { TheRun } from './TheRun';
import { TryToBreak } from './TryToBreak';

export default function Chapters() {
  const { info } = useLanding();
  const incidents = useAsync<Incident[]>(() => api.incidents());
  const receipts = useAsync<{ items?: Receipt[]; note?: string }>(() => api.receipts());
  const hero = info?.hero ?? null;
  const items = receipts.data?.items;
  return (
    <div className="land-rest">
      <HasHappened incidents={incidents.data} receipts={items} loading={incidents.loading} />
      <Blueprint hero={hero} />
      <TheRun hero={hero} />
      <TryToBreak receipts={items} loading={receipts.loading} />
      <Results headline={info?.headline ?? null} receipts={items} />
      <Close />
    </div>
  );
}
