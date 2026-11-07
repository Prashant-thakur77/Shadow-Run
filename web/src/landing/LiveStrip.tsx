import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Health } from '../api/types';
import { num } from '../lib/format';

/** The live system, read from /api/health every 20 seconds while the tab is visible. Nothing here is a recording, and a
 * reading that fails shows nothing rather than an old one. */
export function LiveStrip() {
  const [h, setH] = useState<Health | null>(null);
  const [read, setRead] = useState(false);
  useEffect(() => {
    let stop = false;
    const read = () => {
      if (document.hidden) return;
      api
        .health()
        .then((x) => !stop && setH(x))
        .catch(() => !stop && setH(null))
        .finally(() => !stop && setRead(true));
    };
    read();
    const t = window.setInterval(read, 20000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, []);
  // Until the first reading, hold the strip's one line so the hero doesn't jump when it arrives.
  if (!read) return <div className="live-strip is-waiting" aria-hidden="true" />;
  if (!h?.ok) return null;
  const host = h.runner?.host;
  const fw = h.runner?.firewall;
  const items: { k: string; v: string; good?: boolean }[] = [];
  if (host?.hostname) items.push({ k: 'Vultr VX1', v: `${host.hostname}${host.kvm_device && host.kvm_rw ? ', KVM ready' : ''}`, good: !!(host.kvm_device && host.kvm_rw) });
  if (h.planner_model) items.push({ k: 'Vultr Serverless Inference', v: h.planner_model, good: !!h.inference_base_is_vultr });
  if (h.s3 !== undefined) items.push({ k: 'Vultr Object Storage', v: h.s3 ? 'evidence store up' : 'evidence store down', good: !!h.s3 });
  if (fw?.available) items.push({ k: 'Sandbox firewall', v: `${num(fw.rules)} rules, ${num(fw.rejected_packets)} packets out of sandboxes rejected`, good: true });
  if (!items.length) return null;
  return (
    <div className="live-strip" role="status" aria-label="The live system right now">
      <span className="live-tag">
        <i className="live-dot" aria-hidden="true" />
        Live on Vultr
      </span>
      {items.map((x) => (
        <span className="live-item" key={x.k}>
          <span className="live-k">{x.k}</span> <span className={x.good ? 'live-v' : 'live-v is-off'}>{x.v}</span>
        </span>
      ))}
    </div>
  );
}
