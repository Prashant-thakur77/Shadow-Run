import type { Run } from '../api/types';
import { num, usd } from '../lib/format';
import { Link } from '../lib/router';
import { CopyButton, Fold, Hash } from '../ui/bits';

export function FooterSection({ run }: { run: Run }) {
  const usage = run.usage ?? [];
  return (
    <>
      {run.rerun && (
        <div className="rerun">
          <div className="rerun-head">
            <h3 className="subhead">Repeat this exact plan</h3>
            <CopyButton value={run.rerun} />
          </div>
          <pre className="sql rerun-cmd">{run.rerun}</pre>
        </div>
      )}
      <ul className="footlinks">
        <li>
          <a href={`/api/runs/${encodeURIComponent(run.id)}/evidence`} target="_blank" rel="noreferrer">
            Evidence bundle, as JSON
          </a>
        </li>
        {run.evidence_url && (
          <li>
            <a href={run.evidence_url} target="_blank" rel="noreferrer">
              Evidence bundle, in object storage
            </a>
          </li>
        )}
        <li>
          <Link href={`/audit?run=${encodeURIComponent(run.id)}`}>This run in the audit log</Link>
        </li>
        {run.chain_head && (
          <li className="footlinks-hash">
            <span className="muted">Audit chain head at last event</span> <Hash value={run.chain_head} chars={16} />
          </li>
        )}
      </ul>
      {usage.length > 0 && (
        <Fold summary={`Model calls and cost, ${usd(run.cost_usd)}`}>
          <div className="scroll-x">
            <table className="data data-tight">
              <thead>
                <tr>
                  <th scope="col">Phase</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">Tokens in</th>
                  <th scope="col" className="num">Tokens out</th>
                  <th scope="col" className="num">Seconds</th>
                  <th scope="col" className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u, i) => (
                  <tr key={i}>
                    <th scope="row">{u.phase?.replace(/_/g, ' ')}</th>
                    <td className="mono">{u.model}</td>
                    <td className="mono num">{num(u.prompt_tokens)}</td>
                    <td className="mono num">{num(u.completion_tokens)}</td>
                    <td className="mono num">{num(u.seconds)}</td>
                    <td className="mono num">{usd(u.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Fold>
      )}
    </>
  );
}
