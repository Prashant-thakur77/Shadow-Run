import { api } from '../../api/client';
import type { EvasionFacts, Incident, Market, Receipt } from '../../api/types';
import { useAsync } from '../../lib/useAsync';
import { useLanding } from '../context';
import '../chapters.css';
import { Blueprint } from './Blueprint';
import { Close } from './Close';
import { GotAroundChapter } from './GotAroundChapter';
import { HasHappened } from './HasHappened';
import { Results } from './Results';
import { TheRun } from './TheRun';
import { TryToBreak } from './TryToBreak';
import { WhoPays } from './WhoPays';

export default function Chapters() {
  const { info } = useLanding();
  const incidents = useAsync<Incident[]>(() => api.incidents());
  const receipts = useAsync<{ items?: Receipt[]; note?: string }>(() => api.receipts());
  const market = useAsync<Market>(() => api.market());
  const evasion = useAsync<EvasionFacts>(() => api.evasion());
  const hero = info?.hero ?? null;
  const items = receipts.data?.items;
  return (
    <div className="land-rest">
      <HasHappened incidents={incidents.data} receipts={items} loading={incidents.loading} />
      <Blueprint hero={hero} />
      <TheRun hero={hero} example={info?.applied_example ?? null} />
      <TryToBreak receipts={items} loading={receipts.loading} />
      <GotAroundChapter facts={evasion.data ?? null} />
      <Results headline={info?.headline ?? null} receipts={items} />
      <WhoPays market={market.data} videoUrl={info?.video_url} />
      <Close />
    </div>
  );
}
