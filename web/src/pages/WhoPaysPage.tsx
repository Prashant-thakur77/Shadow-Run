import './_styles';
import '../landing/chapters.css';
import { api } from '../api/client';
import type { Market, PublicInfo } from '../api/types';
import { useAsync } from '../lib/useAsync';
import { WhoPays } from '../landing/chapters/WhoPays';
import { Loading, Notice } from '../ui/bits';

/** The landing page's chapter, for someone already inside the demo, who would otherwise never pass it. */
export function WhoPaysPage() {
  const market = useAsync<Market>(() => api.market());
  const info = useAsync<PublicInfo>(() => api.publicInfo());
  return (
    <div className="page whopays-page">
      {market.error && <Notice tone="bad" title="Could not load this page.">{market.error}</Notice>}
      {!market.data && !market.error && <Loading />}
      <WhoPays market={market.data} videoUrl={info.data?.video_url} />
    </div>
  );
}
