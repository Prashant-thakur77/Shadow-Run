import type { ReactNode } from 'react';
import type { Report } from '../api/types';
import { asText, bytes, num } from '../lib/format';
import { LazyFold } from './lazy';

const FILE_LIST_LIMIT = 300;

function PathList({ title, paths }: { title: string; paths: string[] }) {
  if (!paths.length) return null;
  return (
    <LazyFold summary={`${title}, ${num(paths.length)}`}>
      {() => (
        <>
          <pre className="inert host-files">{paths.slice(0, FILE_LIST_LIMIT).join('\n')}</pre>
          {paths.length > FILE_LIST_LIMIT && <p className="muted">Showing the first {num(FILE_LIST_LIMIT)}.</p>}
        </>
      )}
    </LazyFold>
  );
}

function Names({ label, items, hit }: { label: string; items: (string | number)[]; hit?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd className={hit ? 'mono tone-bad-text' : 'mono'}>{items.map(asText).join(', ')}</dd>
    </div>
  );
}

/** The blast radius on a Linux host: files and services, measured around the plan's steps. */
export function HostBlast({ report, sentences }: { report: Report; sentences: ReactNode }) {
  const t = report.totals ?? {};
  const dirs = report.deleted_by_directory ?? [];
  const biggest = Math.max(1, ...dirs.map((d) => d.files ?? 0));
  const files = report.files ?? {};
  const stopped = report.services_stopped ?? [];
  const closed = report.ports_closed ?? [];
  const started = report.services_started ?? [];
  const after = report.services_after ?? {};

  return (
    <>
      <div className="blast-hero">
        <div className="blast-main">
          <div className="blast-big mono">{num(t.files_deleted)}</div>
          <div className="blast-big-label">
            {t.files_deleted === 1 ? 'file' : 'files'} deleted, measured around the plan's steps on the clone
          </div>
        </div>
        <dl className="blast-parts">
          <div className={(t.services_stopped ?? 0) > 0 ? 'blast-part is-hit' : 'blast-part'}>
            <dt>Services stopped</dt>
            <dd className="mono">{num(t.services_stopped)}</dd>
          </div>
          <div className={(t.ports_closed ?? 0) > 0 ? 'blast-part is-hit' : 'blast-part'}>
            <dt>Ports closed</dt>
            <dd className="mono">{num(t.ports_closed)}</dd>
          </div>
          <div className="blast-part">
            <dt>Space freed</dt>
            <dd className="mono">{bytes(t.bytes_freed)}</dd>
          </div>
          <div className="blast-part">
            <dt>Files changed</dt>
            <dd className="mono">{num(t.files_changed)}</dd>
          </div>
          <div className="blast-part">
            <dt>Files created</dt>
            <dd className="mono">{num(t.files_created)}</dd>
          </div>
        </dl>
      </div>

      {sentences}

      {(stopped.length > 0 || closed.length > 0 || started.length > 0) && (
        <dl className="kvs">
          <Names label="Services stopped" items={stopped} hit />
          <Names label="Ports closed" items={closed} hit />
          <Names label="Services started" items={started} />
        </dl>
      )}

      {dirs.length > 0 && (
        <div>
          <h3 className="subhead">Deleted, by directory</h3>
          <div className="scroll-x">
            <table className="data data-tight">
              <thead>
                <tr>
                  <th scope="col">Directory</th>
                  <th scope="col" className="num">Files</th>
                  <th scope="col" aria-hidden="true"></th>
                </tr>
              </thead>
              <tbody>
                {dirs.map((d) => (
                  <tr key={d.path}>
                    <th scope="row" className="mono">{d.path}</th>
                    <td className="mono num">{num(d.files)}</td>
                    <td className="dirbar-cell">
                      <span className="pctbar" aria-hidden="true">
                        <span style={{ width: `${((d.files ?? 0) / biggest) * 100}%` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {((after.running?.length ?? 0) > 0 || (after.listening_ports?.length ?? 0) > 0) && (
        <dl className="kvs">
          <Names label="Running afterwards" items={after.running ?? []} />
          <Names label="Listening afterwards" items={after.listening_ports ?? []} />
        </dl>
      )}

      <PathList title="Deleted files" paths={files.deleted ?? []} />
      <PathList title="Changed files" paths={files.changed ?? []} />
      <PathList title="Created files" paths={files.created ?? []} />
    </>
  );
}
