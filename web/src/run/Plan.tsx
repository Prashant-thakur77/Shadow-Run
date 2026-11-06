import { useMemo } from 'react';
import type { Attempt, GateFinding } from '../api/types';
import { Hash, Notice, Sql, Tag } from '../ui/bits';
import type { Tone } from '../lib/status';
import { PlanGraph } from './lazy';

const RISK: Record<string, { label: string; tone: Tone }> = {
  read: { label: 'Read', tone: 'neutral' },
  reversible_write: { label: 'Reversible write', tone: 'caution' },
  irreversible_write: { label: 'Irreversible write', tone: 'bad' },
};

const GATE: Record<string, { label: string; tone: Tone }> = {
  pass: { label: 'Gate: pass', tone: 'good' },
  review: { label: 'Gate: review', tone: 'caution' },
  block: { label: 'Gate: block', tone: 'bad' },
};

function severityTone(s?: string): Tone {
  if (s === 'block') return 'bad';
  if (s === 'high') return 'caution';
  return 'neutral';
}

function Findings({ items }: { items: GateFinding[] }) {
  if (!items.length) return null;
  return (
    <ul className="findings">
      {items.map((f, i) => (
        <li key={i}>
          <Tag tone={severityTone(f.severity)}>{f.severity ? f.severity[0].toUpperCase() + f.severity.slice(1) : 'Note'}</Tag>
          <span className="finding-text">
            {f.reason ?? f.rule}
            {f.statement && <code className="mono finding-stmt">{f.statement}</code>}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function PlanSection({ attempt }: { attempt: Attempt }) {
  const steps = attempt.plan?.steps ?? [];
  const gate = attempt.gate;
  const findings = gate?.findings ?? [];
  const risks = useMemo(() => {
    const out: Record<number, string | undefined> = {};
    for (const s of gate?.steps ?? []) out[s.step] = s.risk;
    return out;
  }, [gate]);
  const gateInfo = GATE[gate?.verdict ?? ''];
  const unattached = findings.filter((f) => !f.step || f.step > steps.length);

  return (
    <>
      <div className="plan-head">
        {gateInfo && <Tag tone={gateInfo.tone}>{gateInfo.label}</Tag>}
        <span className="plan-hash">
          <span className="label">Frozen plan</span> <Hash value={attempt.plan_hash} chars={16} />
        </span>
      </div>
      {attempt.plan?.summary && (
        <p className="plan-summary">
          <span className="label">The plan's own summary</span>
          {attempt.plan.summary}
        </p>
      )}
      {attempt.verdict === 'invalid_plan' && (
        <Notice tone="bad" title="The agent did not produce a valid plan.">
          {attempt.error}
        </Notice>
      )}
      {steps.length > 0 && <PlanGraph steps={steps} risks={risks} findings={findings} />}
      <ol className="steps">
        {steps.map((s, i) => {
          const n = i + 1;
          const risk = RISK[risks[n] ?? ''];
          return (
            <li className="step" key={n}>
              <div className="step-head">
                <span className="mono step-n">Step {n}</span>
                {risk ? <Tag tone={risk.tone}>{risk.label}</Tag> : <Tag tone="neutral">Risk unknown</Tag>}
              </div>
              <Sql text={s.cmd} plain={s.type === 'shell'} />
              {s.why && <p className="step-why">{s.why}</p>}
              <Findings items={findings.filter((f) => f.step === n)} />
            </li>
          );
        })}
      </ol>
      <Findings items={unattached} />
    </>
  );
}
