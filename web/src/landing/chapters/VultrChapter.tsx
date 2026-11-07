import type { VultrUsage } from '../../api/types';
import { Link } from '../../lib/router';
import { VultrReceipts } from '../../ui/VultrReceipts';
import { ChapterHead } from './parts';

/** Each Vultr service and what it did, measured. Nothing shows until bench/vultr.json exists. */
export function VultrChapter({ usage }: { usage: VultrUsage | null }) {
  if (!usage?.at) return null;
  return (
    <section className="ch ch-flow" id="vultr" aria-labelledby="vultr-title">
      <div className="ch-inner">
        <VultrReceipts
          data={usage}
          compact
          head={
            <ChapterHead
              id="vultr-title"
              label="On Vultr"
              title="Every layer runs on Vultr."
              lead="The agent thinks on Vultr Serverless Inference, each plan rehearses in a microVM on a VX1, Managed PostgreSQL holds the data it measures, and the evidence goes to Object Storage. These are the counts from the final benchmark and from Vultr's own APIs."
            />
          }
        />
        <Link className="ch-more" href="/results#vultr">
          Which model does what, and every source
        </Link>
      </div>
    </section>
  );
}
