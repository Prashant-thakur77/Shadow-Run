import type { DataFlag } from '../api/types';
import { Tag } from '../ui/bits';

function verdictWord(f: DataFlag): string {
  return f.verdict ? `Advisory verdict: ${f.verdict}` : 'No verdict';
}

export function FlagsSection({ flags }: { flags: DataFlag[] }) {
  return (
    <>
      <p>Rows stored in this snapshot that read like instructions. A safety model votes on each, and its vote is advisory: it decides nothing. Whichever way it votes, the row's text is treated as inert data, never as orders.</p>
      <ul className="flags">
        {flags.map((f, i) => (
          <li className="flag" key={i}>
            <div className="flag-head">
              <code className="mono">
                {f.table}.{f.column}
              </code>
              <Tag tone={f.verdict === 'unsafe' ? 'caution' : 'neutral'}>{verdictWord(f)}</Tag>
              <span className="muted flag-model">
                From <code className="mono">{f.model}</code>. Inert data either way.
              </span>
            </div>
            <pre className="inert">{f.preview}</pre>
          </li>
        ))}
      </ul>
    </>
  );
}
