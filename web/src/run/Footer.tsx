import type { Run, Usage } from '../api/types';
import { num, usd } from '../lib/format';
import { Link } from '../lib/router';
import { CopyButton, Hash } from '../ui/bits';

function byPhase(usage: Usage[]) {
  const out = new Map<string, { phase: string; models: string[]; calls: number; tokensIn: number; tokensOut: number; seconds: number; cost: number }>();
  for (const u of usage) {
    const phase = u.phase ?? 'other';
    const row = out.get(phase) ?? { phase, models: [], calls: 0, tokensIn: 0, tokensOut: 0, seconds: 0, cost: 0 };
    if (u.model && !row.models.includes(u.model)) row.models.push(u.model);
    row.calls += 1;
    row.tokensIn += u.prompt_tokens ?? 0;
    row.tokensOut += u.completion_tokens ?? 0;
    row.seconds += u.seconds ?? 0;
    row.cost += u.cost_usd ?? 0;
    out.set(phase, row);
  }
  return [...out.values()];
}

export function FooterSection({ run }: { run: Run }) {
  const phases = byPhase(run.usage ?? []);
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
      {phases.length > 0 && (
        <div>
          <h3 className="subhead">Cost by phase</h3>
          <div className="scroll-x">
            <table className="data data-tight">
              <thead>
                <tr>
                  <th scope="col">Phase</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">Calls</th>
                  <th scope="col" className="num">Tokens in</th>
                  <th scope="col" className="num">Tokens out</th>
                  <th scope="col" className="num">Seconds</th>
                  <th scope="col" className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {phases.map((p) => (
                  <tr key={p.phase}>
                    <th scope="row">{p.phase.replace(/_/g, ' ')}</th>
                    <td className="mono">{p.models.join(', ')}</td>
                    <td className="mono num">{num(p.calls)}</td>
                    <td className="mono num">{num(p.tokensIn)}</td>
                    <td className="mono num">{num(p.tokensOut)}</td>
                    <td className="mono num">{p.seconds.toFixed(1)}</td>
                    <td className="mono num">{usd(p.cost)}</td>
                  </tr>
                ))}
                <tr className="data-total">
                  <th scope="row">Total</th>
                  <td colSpan={5}></td>
                  <td className="mono num">{usd(run.cost_usd)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
