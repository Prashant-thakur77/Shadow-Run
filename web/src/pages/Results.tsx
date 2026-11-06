import { api } from '../api/client';
import { asText, whenAny } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { CopyButton, Fold, Loading, Notice } from '../ui/bits';

interface ResultsTable {
  columns?: unknown[];
  rows?: unknown[][];
}

export function ResultsPage() {
  const results = useAsync<Record<string, unknown>>(() => api.results());
  const data = results.data;
  const notMeasured = data && data.status === 'not measured yet';
  const table = data?.table as ResultsTable | undefined;
  const hasTable = !!table && Array.isArray(table.columns) && Array.isArray(table.rows);
  const notes = data?.notes;
  const rerun = typeof data?.rerun === 'string' ? data.rerun : null;
  const facts: [string, unknown][] = [
    ['Measured', data?.at ? whenAny(data.at) : undefined],
    ['Model', data?.model],
    ['Runs per task', data?.runs_per_task],
    ['Runs', data?.runs],
    ['Harness errors', data?.harness_errors],
    ['Commit', data?.git_commit],
    ['Scope', data?.scope],
  ];
  const shownFacts = facts.filter(([, v]) => v !== undefined && v !== null);

  return (
    <div className="page results">
      <h1 className="page-title">Results</h1>
      <p className="page-lead">Benchmark results, exactly as the benchmark wrote them. This page has no numbers of its own.</p>
      {results.error && <Notice tone="bad" title="Could not load results.">{results.error}</Notice>}
      {!data && !results.error && <Loading />}
      {notMeasured && (
        <div className="emptystate">
          <div className="emptystate-word">Not measured yet</div>
          <p>The benchmark has not run. There is nothing to show until it has, and nothing here is estimated.</p>
        </div>
      )}
      {data && !notMeasured && (
        <>
          {hasTable ? (
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr>
                    {table?.columns?.map((c, i) => (
                      <th scope="col" key={i}>
                        {asText(c)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table?.rows?.map((r, i) => (
                    <tr key={i}>
                      {(Array.isArray(r) ? r : [r]).map((c, j) => (
                        <td className={j === 0 ? undefined : 'mono'} key={j}>
                          {asText(c)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="notmeasured">The response has no table to show yet. It is below as it arrived.</p>
          )}
          {shownFacts.length > 0 && (
            <dl className="kvs results-facts">
              {shownFacts.map(([k, v]) => (
                <div className="kv" key={k}>
                  <dt>{k}</dt>
                  <dd className="mono">{asText(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {rerun && (
            <div className="rerun">
              <div className="rerun-head">
                <h2 className="subhead">Re-run it</h2>
                <CopyButton value={rerun} />
              </div>
              <pre className="sql rerun-cmd">{rerun}</pre>
            </div>
          )}
          {notes !== undefined && notes !== null && (
            <div className="results-notes">
              <h2 className="subhead">Notes</h2>
              {Array.isArray(notes) ? (
                <ul className="plainlist">
                  {notes.map((n, i) => (
                    <li key={i}>{asText(n)}</li>
                  ))}
                </ul>
              ) : (
                <p>{asText(notes)}</p>
              )}
            </div>
          )}
          <Fold summary="The raw response" open={!hasTable}>
            <pre className="inert">{JSON.stringify(data, null, 2)}</pre>
          </Fold>
        </>
      )}
    </div>
  );
}
