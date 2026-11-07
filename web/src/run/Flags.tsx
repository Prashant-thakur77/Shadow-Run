import type { DataFlag } from '../api/types';
import { Tag } from '../ui/bits';

function voteWord(f: DataFlag): string {
  return f.verdict ? `voted ${f.verdict}` : 'gave no vote';
}

export function FlagsSection({ flags }: { flags: DataFlag[] }) {
  return (
    <>
      <p>Rows stored in this snapshot that read like instructions, found by a pattern match. A safety model votes on each, and it can be wrong: it may call an obvious injection safe. So its vote decides nothing. Whichever way it goes, the row's text is treated as inert data, never as orders.</p>
      <ul className="flags">
        {flags.map((f, i) => (
          <li className="flag" key={i}>
            <div className="flag-head">
              <code className="mono">
                {f.table}.{f.column}
              </code>
              <Tag tone="caution">Reads like instructions</Tag>
              <span className="muted flag-model">
                The safety model <code className="mono">{f.model}</code> {voteWord(f)}. Inert data either way.
              </span>
            </div>
            <pre className="inert">{f.preview}</pre>
          </li>
        ))}
      </ul>
    </>
  );
}
