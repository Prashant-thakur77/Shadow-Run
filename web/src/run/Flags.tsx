import type { DataFlag } from '../api/types';
import { Tag } from '../ui/bits';

export function FlagsSection({ flags }: { flags: DataFlag[] }) {
  return (
    <>
      <p>Rows stored in this snapshot that read like instructions, with the safety model's verdict on each. They are shown as inert text and treated as data, never as orders.</p>
      <ul className="flags">
        {flags.map((f, i) => (
          <li className="flag" key={i}>
            <div className="flag-head">
              <code className="mono">
                {f.table}.{f.column}
              </code>
              <Tag tone={f.verdict === 'unsafe' ? 'bad' : 'neutral'}>{f.verdict === 'unsafe' ? 'Unsafe' : f.verdict === 'safe' ? 'Safe' : (f.verdict ?? 'No verdict')}</Tag>
              <span className="muted flag-model">
                Safety model <code className="mono">{f.model}</code>
              </span>
            </div>
            <pre className="inert">{f.preview}</pre>
          </li>
        ))}
      </ul>
    </>
  );
}
