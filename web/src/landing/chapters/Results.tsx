import { VerdictPair } from '../../ui/VerdictBlock';
import type { PublicInfo, Receipt } from '../../api/types';
import { controlSplit } from '../../lib/controls';
import { asText, isNum, num, whenAny } from '../../lib/format';
import { Link } from '../../lib/router';
import { Mark } from '../../ui/bits';
import { finishesMore, HoldQueueAnswer, Outcomes, type OutcomeMode } from '../../ui/Outcomes';
import { ChapterHead, groupOf, tally } from './parts';

type Headline = NonNullable<PublicInfo['headline']>;

const MODES: { key: keyof Headline; label: string }[] = [
  { key: 'direct', label: 'Agent directly' },
  { key: 'static_gate', label: 'Rule gate' },
  { key: 'shadow_run', label: 'Shadow Run, with no person' },
  { key: 'rubber_stamp', label: 'Shadow Run, if a person approves every plan unread' },
];

function outcomeModes(h: Headline): OutcomeMode[] {
  return [
    { key: 'direct', label: 'Agent directly', done: { mean: h.done_direct }, harm: { mean: h.direct } },
    { key: 'static_gate', label: 'Rule gate', done: { mean: h.done_static_gate }, harm: { mean: h.static_gate } },
    { key: 'unread', label: 'A person approves every plan unread', done: { mean: h.done_unread }, harm: { mean: h.rubber_stamp } },
  ];
}

/** Said only when the numbers say it, since the benchmark can be run again. */
function externalGapIsSmaller(h: Headline): boolean {
  const e = h.external;
  return isNum(e?.done_unread) && isNum(e?.done_direct) && isNum(h.done_unread) && isNum(h.done_direct) && e.done_unread - e.done_direct < h.done_unread - h.done_direct;
}

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
  const modes = outcomeModes(headline);
  const total = headline.risky_tasks;
  return (
    <div className="results-measured">
      <VerdictPair harm={headline.task_level?.harm ?? undefined} done={headline.task_level?.done ?? undefined} tasks={total} />
      <h3 className="t-h3 results-title">
        What happened on <span className="mono">{num(total)}</span> risky tasks held out from tuning
      </h3>
      <Outcomes total={total} modes={modes} aside={<HoldQueueAnswer total={total} modes={modes} harmAlone={headline.shadow_run} held={headline.held} doneIsClear={!!headline.task_level?.done?.excludes_zero} />} />
      <p className="t-caption">
        Mean of {num(headline.runs_per_task)} runs per task, so a count can be a fraction. Neither is the tasks minus the other two. Measured {whenAny(headline.measured_at)}. Nothing here is estimated.
        {headline.external?.risky_tasks ? (
          <>
            {' '}
            These tasks are our own. On {num(headline.external.risky_tasks)} tasks adapted from outside this project{externalGapIsSmaller(headline) ? ', the gap is smaller' : ''}: {num(headline.external.done_direct)} done by the agent directly, {num(headline.external.done_unread)} with a person approving every plan unread.
          </>
        ) : null}{' '}
        <Link href="/results">All results</Link>
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
  const split = controlSplit(controls);
  const soak = groupOf(receipts, 'Soak')[0];
  const replayed = groupOf(receipts, 'Guardrail gauntlet').find((r) => /replayed against/i.test(r.claim ?? ''));
  const allGood = (t: { hit: number; total: number }) => (t.hit === t.total ? 'good' : 'bad');
  const tests = headline?.task_level;
  const more = !!headline && finishesMore(outcomeModes(headline)) && !!tests?.done?.excludes_zero;
  const less = !!tests?.harm?.excludes_zero && (tests.harm.difference ?? 0) < 0;
  return (
    <section className="ch ch-screen" id="results" aria-labelledby="results-title">
      <div className="ch-inner">
        <ChapterHead id="results-title" label="Results" title={more ? 'The agent finishes more of the work correctly.' : less ? 'Less harm on prod. Nothing here is estimated.' : 'Nothing here is estimated.'} />
        <Benchmark headline={headline} />
        <dl className="tiles tiles-receipts">
          {redTally ? <Stat value={`${redTally.hit} of ${redTally.total}`} label="Red team attacks contained, real attacks in real microVMs" source={red[0]?.source} tone={allGood(redTally)} /> : <Stat value="Not measured" label="Red team" />}
          {controlTally ? <Stat value={`${controlTally.hit} of ${controlTally.total}`} label={split ? `Negative controls: ${split.words}.` : 'Negative controls pass.'} source={controls[0]?.source} tone={allGood(controlTally)} /> : <Stat value="Not measured" label="Negative controls" />}
          {soak ? <Stat value={soak.value === 'yes' && soak.count ? `${num(soak.count)} of ${num(soak.count)}` : asText(soak.value)} label={soak.claim ?? 'Soak'} source={soak.source} tone={soak.value === 'yes' ? 'good' : 'bad'} /> : <Stat value="Not measured" label="Soak" />}
          {replayed ? <Stat value={asText(replayed.value)} label={replayed.claim ?? ''} source={replayed.source} /> : <Stat value="Not measured" label="Guardrail gauntlet" />}
        </dl>
        <Link className="ch-more" href="/receipts">
          Every receipt, and the command that reproduces it
        </Link>
      </div>
    </section>
  );
}
