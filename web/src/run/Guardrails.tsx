import type { Attempt, Dict, GuardrailResult, Run } from '../api/types';
import { asText, ms, num } from '../lib/format';
import { Fold, Hash, Mark, Sql, Tag } from '../ui/bits';

function offending(v: Dict): string {
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === 'id') return asText(v.id);
  return keys.map((k) => `${k}: ${asText(v[k])}`).join(', ');
}

function countText(g: GuardrailResult): string {
  const shown = g.violations?.length ?? 0;
  const capped = g.violation_count_capped ?? shown;
  // The runner stops counting at its cap, so a count above what is listed means "at least".
  const count = capped > shown ? `${num(capped)}+` : num(capped);
  return `${count} offending ${capped === 1 ? 'row' : 'rows'}`;
}

export function GuardrailsSection({ run, attempt }: { run: Run; attempt: Attempt | null }) {
  const results = attempt?.guardrails;
  const frozen = run.guardrails ?? [];
  const hash = attempt?.guardrails_hash ?? run.guardrails_hash;
  const byId = new Map(frozen.map((g) => [g.id, g]));
  const failed = (results ?? []).filter((g) => g.passed === false).length;
  const budget = attempt?.budget;
  // What failed is what someone needs to read. Order inside each group stays as the guardrails were written.
  const ordered = results ? [...results].sort((a, b) => Number(a.passed !== false) - Number(b.passed !== false)) : null;

  return (
    <>
      <div className="frozen">
        <p className="frozen-text">
          <strong>Frozen. The agent can't edit these.</strong> A failed guardrail can't be approved past.
        </p>
        <div className="frozen-hash">
          <span className="label">Guardrails hash</span>
          <Hash value={hash} chars={20} />
        </div>
      </div>

      {results ? (
        <p className="guardrail-sum mono">
          {num(results.length - failed)} of {num(results.length)} passed
          {failed > 0 && <span className="tone-bad-text">, {num(failed)} failed</span>}
        </p>
      ) : (
        <p className="notmeasured">Not checked on this attempt. They only run after a rehearsal finishes.</p>
      )}

      <ul className="guardrails">
        {(ordered ?? frozen.map((g) => ({ id: g.id, name: g.name } as GuardrailResult))).map((g) => {
          const def = byId.get(g.id);
          const state = !results ? 'neutral' : g.error ? 'bad' : g.passed ? 'good' : 'bad';
          return (
            <li key={g.id ?? g.name} className={`guardrail is-${state}`}>
              <div className="guardrail-state">
                <Mark tone={state} size={15} />
                <span>{!results ? 'Not run' : g.error ? 'Error' : g.passed ? 'Pass' : 'Fail'}</span>
              </div>
              <div className="guardrail-main">
                <div className="guardrail-name">{g.name ?? g.id}</div>
                {def?.why && g.passed !== true && <p className="guardrail-why">{def.why}</p>}
                {g.error && <p className="guardrail-error mono">{g.error}</p>}
                {g.passed === false && g.output && <pre className="inert guardrail-output">{g.output}</pre>}
                {g.passed === false && (g.violations?.length ?? 0) > 0 && (
                  <p className="guardrail-rows">
                    <span>{countText(g)}: </span>
                    <code className="mono">{g.violations?.map(offending).join(', ')}</code>
                  </p>
                )}
                {(def?.sql || def?.sh) && (
                  <Fold summary="The check">
                    {def.why && g.passed === true && <p className="guardrail-why">{def.why}</p>}
                    <Sql text={def.sql ?? def.sh} plain={!def.sql} />
                    {def.accepted_by && <p className="muted">Accepted by {def.accepted_by}.</p>}
                  </Fold>
                )}
              </div>
              <div className="guardrail-ms mono">{g.ms !== undefined ? ms(g.ms) : ''}</div>
            </li>
          );
        })}
      </ul>

      {budget && (
        <div className="budgetbox">
          <h3 className="subhead">Blast-radius budget</h3>
          <p>
            <Tag tone={budget.within ? 'good' : 'caution'}>{budget.within ? 'Within budget' : 'Needs a person'}</Tag>{' '}
            {budget.within ? 'No person has to approve this one.' : 'A person has to approve this, if nothing else stopped it.'}
          </p>
          {(budget.reasons?.length ?? 0) > 0 && (
            <ul className="plainlist mono">
              {/* The same reason can appear once per step, so the text alone isn't a unique key. */}
              {[...new Set(budget.reasons)].map((r) => {
                const times = budget.reasons?.filter((other) => other === r).length ?? 1;
                return (
                  <li key={r}>
                    {r}
                    {times > 1 && <span className="muted"> ({times} times)</span>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
