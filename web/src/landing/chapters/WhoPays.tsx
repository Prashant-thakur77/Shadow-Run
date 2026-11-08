import type { Market } from '../../api/types';
import { num } from '../../lib/format';
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

/** The file says control plane, which means nothing to someone reading this for the first time. */
const plainWords = (line: string) => line.replace('the control plane and sandboxes', 'Shadow Run');

/** Every figure comes from docs/market.json with its source. The one number we worked out is labelled as ours. */
export function WhoPays({ market, videoUrl }: { market: Market | null; videoUrl?: string | null }) {
  if (!market?.price) return null;
  const { agents_market: agents, guardian_share: guardian, developers_using_agents: devs, postgres_companies: pg, derived, price, us } = market;
  return (
    <section className="ch ch-flow" id="who-pays" aria-labelledby="who-pays-title">
      <div className="ch-inner pays">
        <div className="pays-top">
          <ChapterHead
            id="who-pays-title"
            label="Who pays"
            title="Whoever answers for the database."
            lead="At a team that lets coding agents run migrations and data fixes. Today that person gives the agent a credential and hopes, or has a senior engineer read each statement and guess what it cascades into. There are no customers yet, and the price below is a plan."
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
            <p className="pays-figure">
              <span className="t-num-m">Free</span> <span className="pays-unit">the pull request Action</span>
            </p>
            <p className="pays-figure">
              <span className="t-num-m">${num(price.usd_per_database_month)}</span> <span className="pays-unit">a month per protected database</span>
            </p>
            <p className="pays-planned">Planned, untested. No customer has seen this price.</p>
            {market.revenue?.map((line) => (
              <p className="pays-note" key={line}>
                {plainWords(line)}
              </p>
            ))}
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
            {derived?.sam_usd_b_per_year !== undefined && <p className="pays-note">All of them, one database each, would be ${derived.sam_usd_b_per_year} billion a year. That is a ceiling, not a forecast: not all of them let agents near prod. Our arithmetic, at a price nobody has tested.</p>}
          </div>
        </div>

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
                  <td data-label="Where it's weak">
                    <strong>Scope today.</strong> {us.weakness}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {market.as_of && <p className="t-caption pays-source">docs/market.json, sources checked {market.as_of}. Each figure links to where it came from. Nothing here was measured by Shadow Run.</p>}
      </div>
    </section>
  );
}
