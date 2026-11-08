import type { Economics, Market } from '../../api/types';
import { isNum, num } from '../../lib/format';
import { Label } from '../../ui/Label';
import { ChapterHead } from './parts';

const SLIDES = 'https://github.com/Prashant-thakur77/Shadow-Run/blob/main/docs/slides.pdf';

function Source({ name, url }: { name?: string; url?: string }) {
  if (!name) return null;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      {name}
    </a>
  ) : (
    <>{name}</>
  );
}

/** Whole dollars, as the README rounds them. */
const dollars = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
/** A cost of a fraction of a cent, to three significant figures. */
const cents = (v: number) => `$${Number(v.toPrecision(3))}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

/** The size the hosted tier serves today, from the largest database a full rehearsal finished on. */
function servedSize(mb: number | null | undefined): string | null {
  if (!isNum(mb) || mb <= 0) return null;
  return mb >= 1000 ? `about ${num(Math.round(mb / 1000))} GB` : `about ${num(mb)} MB`;
}

const MARGIN_WORDS: [string, string][] = [
  ['1', 'one database'],
  ['2', 'two on the same deployment'],
  ['3', 'three'],
];

/** What it costs to serve, every figure from the API (control/economics.py, the README's arithmetic on the published
 *  benchmark). Nothing shows without it, and the fixed cost and margins only when the deployment's resources were read. */
function CostToServe({ e }: { e: Economics }) {
  const fixed = isNum(e.fixed) ? e.fixed : null;
  const margins = fixed !== null && e.margin_k ? MARGIN_WORDS.filter(([k]) => isNum(e.margin_k?.[k])) : [];
  return (
    <div className="pays-grid pays-cost">
      <div className="pays-cell">
        <Label>Cost to serve</Label>
        <p className="pays-cost-what">Infrastructure gross margin, list prices, measured costs.</p>
        <p className="pays-note">
          Inference and VX1 time are the benchmark's own means over its {num(e.tasks)} tasks. The control VM, the VX1 host and the bucket are at Vultr's list price. Prod is the team's own database, so it
          isn't counted.
        </p>
      </div>
      <div className="pays-cell">
        <span className="pays-tier">Variable cost</span>
        <p className="pays-figure">
          <span className="t-num-m">${e.per_k.toFixed(2)}</span> <span className="pays-unit">per 1,000 rehearsed tasks</span>
        </p>
        <p className="pays-note">
          {cents(e.inf)} of inference and at most {cents(e.vx1_task)} of VX1 time a task: the whole host, at {cents(e.vx1)} an hour, for the task's whole {num(e.secs)} s.
        </p>
      </div>
      {fixed !== null && (
        <div className="pays-cell">
          <span className="pays-tier">Fixed cost, per deployment</span>
          <p className="pays-figure">
            <span className="t-num-m">{dollars(fixed)}</span> <span className="pays-unit">a month</span>
          </p>
          <p className="pays-note">A deployment serves one team. A second database on it adds only its variable cost.</p>
        </div>
      )}
      {margins.length > 0 && (
        <div className="pays-cell">
          <span className="pays-tier">Gross margin at {dollars(e.price)} a month</span>
          {margins.map(([k, words]) => (
            <p className="pays-figure" key={k}>
              <span className="t-num-m">{percent(e.margin_k![k])}</span> <span className="pays-unit">{words}</span>
            </p>
          ))}
          <p className="pays-note">With 1,000 rehearsed tasks a month on each database, fixed cost included.</p>
        </div>
      )}
    </div>
  );
}

/** Every market figure comes from docs/market.json with its source, and the one number we worked out is labelled as ours.
 *  The cost to serve is measured, and the API adds it. */
export function WhoPays({ market, videoUrl }: { market: Market | null; videoUrl?: string | null }) {
  if (!market?.price) return null;
  const { agents_market: agents, guardian_share: guardian, developers_using_agents: devs, postgres_companies: pg, derived, price, us } = market;
  const e = market.economics ?? null;
  const fixed = e && isNum(e.fixed) ? e.fixed : null;
  const size = servedSize(market.served_db_mb);
  return (
    <section className="ch ch-flow" id="who-pays" aria-labelledby="who-pays-title">
      <div className="ch-inner pays">
        <div className="pays-top">
          <ChapterHead
            id="who-pays-title"
            label="Who pays"
            title="Whoever answers for the database."
            lead="At a team that lets coding agents run migrations and data fixes. Today that person gives the agent a credential and hopes, or has a senior engineer read each statement and guess what it cascades into. The price below is our plan."
          />
          <div className="pays-side">
            {market.agent_incidents?.can_stop_automatically_pct != null && (
              <figure className="pays-stat">
                <span className="pays-stat-n mono">{market.agent_incidents.can_stop_automatically_pct}%</span>
                <figcaption>
                  of surveyed professionals say their organization can automatically stop an AI agent in production; {market.agent_incidents.unexpected_or_unauthorized_pct}% had confirmed or
                  suspected one acting unexpectedly or without authorization.{' '}
                  <Source name={market.agent_incidents.source} url={market.agent_incidents.url} />
                </figcaption>
              </figure>
            )}
          <ul className="pays-links">
            {videoUrl && (
              <li>
                <a className="btn" href={videoUrl} target="_blank" rel="noreferrer">
                  Watch the video
                </a>
              </li>
            )}
            <li>
              <a className="btn" href={SLIDES} target="_blank" rel="noreferrer">
                The slides, PDF
              </a>
            </li>
          </ul>
          </div>
        </div>

        <div className="pays-grid">
          <div className="pays-cell">
            <Label>How a team starts</Label>
            <ol className="pays-steps">
              {market.funnel?.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
          <div className="pays-cell">
            <Label>What it costs</Label>
            <ol className="pays-ladder">
              <li>
                <span className="pays-tier">Self-hosted, open source</span>
                <p className="pays-figure">
                  <span className="t-num-m">Free</span>{' '}
                  <span className="pays-unit">
                    the team pays Vultr for what it runs{fixed !== null && <>, about {dollars(fixed)} a month at list price</>}
                  </span>
                </p>
              </li>
              <li>
                <span className="pays-tier">Hosted, inside the team's own Vultr account</span>
                <p className="pays-figure">
                  <span className="t-num-m">${num(price.usd_per_database_month)}</span>{' '}
                  <span className="pays-unit">
                    a month per protected database{size && <>, up to {size} today</>}
                  </span>
                </p>
              </li>
              <li>
                <span className="pays-tier">Regulated teams</span>
                <p className="pays-note">Self-hosted, with a support licence.</p>
              </li>
            </ol>
            <p className="pays-planned">Our planned price.</p>
          </div>
          <div className="pays-cell">
            <Label>First target</Label>
            {derived && (
              <p className="pays-figure">
                <span className="t-num-m">${num(derived.first_target_usd_m_per_year)}M</span> <span className="pays-unit">a year, if {num(derived.first_target_pct)}% of the companies using PostgreSQL pay</span>
              </p>
            )}
            {pg && (
              <p className="pays-note">
                {num(pg.count)} companies use it, by <Source name={pg.source} url={pg.url} />'s count. {pg.caveat}
              </p>
            )}
            {derived?.sam_usd_b_per_year !== undefined && <p className="pays-note">All of them, one database each, would be ${derived.sam_usd_b_per_year} billion a year. That is a ceiling, not a forecast: not all of them let agents near prod. Our arithmetic.</p>}
          </div>
        </div>

        {e && isNum(e.per_k) && isNum(e.price) && <CostToServe e={e} />}

        <div className="pays-split">
          <div className="pays-half">
            <Label>The market, with sources</Label>
            <ul className="pays-market">
              {devs && (
                <li>
                  {num(devs.weekly_pct)}% of professional developers use coding agents at least weekly, and {num(devs.daily_pct)}% daily. <Source name={devs.source} url={devs.url} />, {devs.respondents} respondents.
                </li>
              )}
              {agents && (
                <li>
                  AI agents are sized at ${agents.usd_b_2025} billion in 2025 and ${agents.usd_b_2033} billion by 2033. <Source name={agents.source} url={agents.url} />.
                </li>
              )}
              {guardian && (
                <li>
                  Guardian agents, the category this sits in, are expected to take {num(guardian.low_pct)} to {num(guardian.high_pct)}% of that by {guardian.by_year}. <Source name={guardian.source} url={guardian.url} />.
                </li>
              )}
            </ul>
          </div>
          <div className="pays-half">
            <Label>What comes next</Label>
            <ol className="pays-steps">
              {market.next?.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </div>

        <div className="pays-table-wrap" role="region" aria-label="Competition">
          <table className="data pays-table">
            <thead>
              <tr>
                <th scope="col">Who else</th>
                <th scope="col">What they do well</th>
                <th scope="col">What's missing for this job</th>
              </tr>
            </thead>
            <tbody>
              {market.competition?.map((c) => (
                <tr key={c.who}>
                  <th scope="row">{c.who}</th>
                  <td data-label="What they do well">{c.strength}</td>
                  <td data-label="What's missing for this job">{c.gap}</td>
                </tr>
              ))}
              {us && (
                <tr className="pays-us">
                  <th scope="row">Shadow Run</th>
                  <td data-label="What it does well">{us.strength}</td>
                  <td data-label="Scope today">
                    <strong>Scope today.</strong> {us.weakness}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {market.as_of && (
          <p className="t-caption pays-source">
            docs/market.json, sources checked {market.as_of}. Each figure links to where it came from.{' '}
            {e ? 'The cost to serve comes from the benchmark\'s own records and Vultr\'s list prices (bench/results.json, bench/vultr.json); nothing else here was measured by Shadow Run.' : 'Nothing here was measured by Shadow Run.'}
          </p>
        )}
      </div>
    </section>
  );
}
