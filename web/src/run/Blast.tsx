import type { Attempt, Report, ReportTable } from '../api/types';
import { isNum, num, pct } from '../lib/format';
import { Notice } from '../ui/bits';
import { HostBlast } from './HostBlast';
import { CascadeGraph, LazyFold, SampleDiff } from './lazy';

function whyNoReport(a: Attempt | null): string {
  switch (a?.verdict) {
    case 'blocked_by_gate':
      return 'Not measured. The static gate refused the plan before any rehearsal.';
    case 'sql_error':
      return 'Not measured. The plan failed on the clone, so its transaction never finished.';
    case 'sandbox_error':
      return 'Not measured. The sandbox failed.';
    case 'invalid_plan':
      return 'Not measured. There was no valid plan to rehearse.';
    default:
      return 'Not measured yet.';
  }
}

function Hero({ report }: { report: Report }) {
  const t = report.totals ?? {};
  const cascade = t.rows_via_cascade ?? 0;
  return (
    <div className="blast-hero">
      <div className="blast-main">
        <div className="blast-big mono">{num(t.rows_changed)}</div>
        <div className="blast-big-label">
          {t.rows_changed === 1 ? 'row' : 'rows'} changed across {num(t.tables_touched)} {t.tables_touched === 1 ? 'table' : 'tables'}, measured by Postgres on the clone
        </div>
      </div>
      <dl className="blast-parts">
        <div className={cascade > 0 ? 'blast-part is-hit' : 'blast-part'}>
          <dt>Via cascade</dt>
          <dd className="mono">{num(t.rows_via_cascade)}</dd>
          {cascade > 0 && <p className="blast-part-note">From foreign keys, not from the plan's statements.</p>}
        </div>
        <div className="blast-part">
          <dt>Deleted</dt>
          <dd className="mono">{num(t.rows_deleted)}</dd>
        </div>
        <div className="blast-part">
          <dt>Updated</dt>
          <dd className="mono">{num(t.rows_updated)}</dd>
        </div>
        {(t.rows_inserted ?? 0) > 0 && (
          <div className="blast-part">
            <dt>Inserted</dt>
            <dd className="mono">{num(t.rows_inserted)}</dd>
          </div>
        )}
      </dl>
      {((t.tables_dropped ?? 0) > 0 || (t.tables_truncated ?? 0) > 0 || (t.ddl_commands ?? 0) > 0) && (
        <p className="blast-ddl mono">
          {(t.tables_dropped ?? 0) > 0 && <span>{num(t.tables_dropped)} tables dropped. </span>}
          {(t.tables_truncated ?? 0) > 0 && <span>{num(t.tables_truncated)} tables truncated. </span>}
          {(t.ddl_commands ?? 0) > 0 && <span>{num(t.ddl_commands)} DDL commands.</span>}
        </p>
      )}
    </div>
  );
}

function Sentences({ report }: { report: Report }) {
  const items = report.sentences ?? [];
  if (!items.length) return null;
  return (
    <ul className="sentences">
      {items.map((s, i) => {
        const text = s.text ?? '';
        // The API's line starts with the row count. Pull it into its own aligned column.
        const lead = isNum(s.rows) ? String(s.rows) : null;
        const rest = lead && text.startsWith(lead) ? text.slice(lead.length).trim() : text;
        return (
          <li key={i} className={s.via === 'cascade' ? 'sentence is-cascade' : 'sentence'}>
            <span className="sentence-rows mono">{lead ? num(s.rows) : ''}</span>
            <span className="sentence-text">
              {rest}
              {s.path && <span className="sentence-path mono">{s.path}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TableRow({ t }: { t: ReportTable }) {
  const p = t.pct_of_table;
  return (
    <tr>
      <th scope="row" className="mono">
        {t.table}
        {t.dropped && <span className="flagword"> dropped</span>}
        {t.truncated && <span className="flagword"> truncated</span>}
      </th>
      <td className="mono num nowrap">
        {num(t.rows_before)} <span className="arrow">→</span> {t.dropped ? 'gone' : num(t.rows_after)}
      </td>
      <td className="pctcell">
        <span className="mono pctcell-num">{pct(p)}</span>
        <span className="pctbar" aria-hidden="true">
          <span style={{ width: isNum(p) ? `${Math.min(100, Math.max(0, p))}%` : 0 }} />
        </span>
      </td>
      <td className="mono num">{num(t.deleted)}</td>
      <td className="mono num">{num(t.updated)}</td>
      <td className="mono num">{num(t.inserted)}</td>
      <td className="mono num">{num(t.direct)}</td>
      <td className="mono num">{num(t.cascade)}</td>
    </tr>
  );
}

export function BlastSection({ attempt }: { attempt: Attempt | null }) {
  const report = attempt?.report;
  if (!report) {
    return (
      <>
        <p className="notmeasured">{whyNoReport(attempt)}</p>
        {attempt?.error && (
          <Notice tone="bad" title="What Postgres said">
            <span className="mono">{attempt.error}</span>
          </Notice>
        )}
      </>
    );
  }
  if (report.kind === 'host') {
    return (
      <HostBlast report={report} sentences={<Sentences report={report} />} />
    );
  }
  const graph = report.cascade_graph;
  const hasGraph = (graph?.edges?.length ?? 0) > 0;
  const samples = Object.entries(report.samples ?? {});
  const ddl = report.ddl ?? [];
  const schemaDiff = report.schema_diff ?? [];

  return (
    <>
      <Hero report={report} />
      <Sentences report={report} />

      {hasGraph && (
        <div className="blast-graph">
          <h3 className="subhead">Where it spread</h3>
          <CascadeGraph nodes={graph?.nodes ?? []} edges={graph?.edges ?? []} />
          <p className="legend">
            <span className="legend-item">
              <span className="legend-line" /> CASCADE deletes the child rows
            </span>
            <span className="legend-item">
              <span className="legend-line is-dashed" /> SET NULL keeps the row and clears its link
            </span>
          </p>
        </div>
      )}

      {(report.tables?.length ?? 0) > 0 && (
        <div>
          <h3 className="subhead">Per table</h3>
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Table</th>
                  <th scope="col" className="num">Rows before → after</th>
                  <th scope="col">% of table</th>
                  <th scope="col" className="num">Deleted</th>
                  <th scope="col" className="num">Updated</th>
                  <th scope="col" className="num">Inserted</th>
                  <th scope="col" className="num">Direct</th>
                  <th scope="col" className="num">Cascade</th>
                </tr>
              </thead>
              <tbody>
                {report.tables?.map((t) => <TableRow key={t.table} t={t} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {ddl.length > 0 && (
        <div>
          <h3 className="subhead">Schema commands</h3>
          <ul className="plainlist mono">
            {ddl.map((d, i) => (
              <li key={i}>
                Step {num(d.step)}: {d.tag} {d.object_type} {d.identity}
              </li>
            ))}
          </ul>
        </div>
      )}
      {schemaDiff.length > 0 && (
        <div>
          <h3 className="subhead">Schema difference</h3>
          <ul className="plainlist mono">
            {schemaDiff.map((d, i) => (
              <li key={i}>
                {d.change} {d.kind} {d.name}
              </li>
            ))}
          </ul>
        </div>
      )}

      {samples.length > 0 && (
        <LazyFold summary={`Sample rows, before and after, ${samples.length} ${samples.length === 1 ? 'table' : 'tables'}`}>
          {() => (
            <div className="sample-tables">
              {samples.map(([table, ops]) =>
                Object.entries(ops ?? {}).map(([op, rows]) => (
                  <LazyFold
                    key={`${table}-${op}`}
                    summary={
                      <>
                        <span className="mono">{table}</span> <span className="muted">{op}, {rows.length} {rows.length === 1 ? 'row' : 'rows'}</span>
                      </>
                    }
                  >
                    {() => <SampleDiff rows={rows} op={op} />}
                  </LazyFold>
                )),
              )}
            </div>
          )}
        </LazyFold>
      )}
    </>
  );
}
