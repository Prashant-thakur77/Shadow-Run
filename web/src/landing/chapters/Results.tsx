import type { PublicInfo, Receipt } from '../../api/types';
import { asText, num, whenAny } from '../../lib/format';
import { Link } from '../../lib/router';
import { Mark } from '../../ui/bits';
import { ChapterHead, groupOf, tally } from './parts';

type Headline = NonNullable<PublicInfo['headline']>;

const MODES: { key: keyof Headline; label: string; strong?: boolean }[] = [
  { key: 'direct', label: 'Agent directly' },
  { key: 'static_gate', label: 'Static gate' },
  { key: 'shadow_run', label: 'Shadow Run, with no person', strong: true },
  { key: 'rubber_stamp', label: 'Shadow Run, if a person approves every plan unread' },
];

/** Every number here comes from the benchmark's own file. Before it has run, nothing is shown. */
function Benchmark({ headline }: { headline: Headline | null }) {
  if (!headline) {
    return (
      <div className="results-empty">
        <p className="t-display-l">Not measured yet</p>
        <p className="results-empty-note">
          The benchmark has not finished on this build, so there is no number to show here. Nothing is estimated. <code>bash scripts/final.sh</code> produces them.
        </p>
        <div className="tiles tiles-empty" aria-hidden="true">
          {MODES.map((m) => (
            <div className="tile tile-empty" key={m.key}>
              <span className="tile-label">{m.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="results-measured">
      <h3 className="t-h3 results-title">
        Harmful outcomes on prod, of <span className="mono">{num(headline.risky_tasks)}</span> risky tasks held out from tuning
      </h3>
      <dl className="tiles">
        {MODES.map((m) => {
          const value = headline[m.key] as number | undefined;
          const tone = value === 0 ? 'good' : 'bad';
          return (
            <div className={`tile is-${tone}${m.strong ? ' is-strong' : ''}`} key={m.key}>
              <dd className="t-num-l tile-value">{num(value)}</dd>
              <dt className="tile-label">{m.label}</dt>
            </div>
          );
        })}
      </dl>
      <p className="t-caption">
        Mean of {num(headline.runs_per_task)} runs per task. Measured {whenAny(headline.measured_at)}. <Link href="/results">All results</Link>
      </p>
    </div>
  );
}

function Stat({ value, label, source, tone }: { value: string; label: string; source?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`tile${tone ? ` is-${tone}` : ''}`}>
      <dd className="t-num-m tile-value">
        {tone && <Mark tone={tone} size={15} />} {value}
      </dd>
      <dt className="tile-label">{label}</dt>
      {source && <span className="t-caption">{source}</span>}
    </div>
  );
}

export function Results({ headline, receipts }: { headline: Headline | null; receipts: Receipt[] | undefined }) {
  const red = groupOf(receipts, 'Red team');
  const redTally = tally(red, 'contained');
  const controls = groupOf(receipts, 'Negative controls');
  const controlTally = tally(controls, 'pass');
  const soak = groupOf(receipts, 'Soak')[0];
  const replayed = groupOf(receipts, 'Guardrail gauntlet').find((r) => /replayed against/i.test(r.claim ?? ''));
  const allGood = (t: { hit: number; total: number }) => (t.hit === t.total ? 'good' : 'bad');
  return (
    <section className="ch ch-screen" id="results" aria-labelledby="results-title">
      <div className="ch-inner">
        <ChapterHead id="results-title" label="Results" title="Nothing here is estimated." />
        <Benchmark headline={headline} />
        <dl className="tiles tiles-receipts">
          {redTally ? <Stat value={`${redTally.hit} of ${redTally.total}`} label="Red team attacks contained, real attacks in real microVMs" source={red[0]?.source} tone={allGood(redTally)} /> : <Stat value="Not measured" label="Red team" />}
          {controlTally ? <Stat value={`${controlTally.hit} of ${controlTally.total}`} label="Negative controls pass. Each one tries to get past a check." source={controls[0]?.source} tone={allGood(controlTally)} /> : <Stat value="Not measured" label="Negative controls" />}
          {soak ? <Stat value={asText(soak.value)} label={soak.claim ?? 'Soak'} source={soak.source} tone={soak.value === 'yes' ? 'good' : 'bad'} /> : <Stat value="Not measured" label="Soak" />}
          {replayed ? <Stat value={asText(replayed.value)} label={replayed.claim ?? ''} source={replayed.source} /> : <Stat value="Not measured" label="Guardrail gauntlet" />}
        </dl>
        <Link className="ch-more" href="/receipts">
          Every receipt, and the command that reproduces it
        </Link>
      </div>
    </section>
  );
}
