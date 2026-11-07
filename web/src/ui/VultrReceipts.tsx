import '../styles/vultr.css';
import type { ReactNode } from 'react';
import type { VultrUsage } from '../api/types';
import { bytes, isNum, ms, num } from '../lib/format';
import { sourceLine } from './Figure';
import { Label } from './Label';

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const big = (v: unknown) => (isNum(v) ? compact.format(v) : num(v));
const dollars = (v: unknown) => (isNum(v) ? `$${v.toFixed(2)}` : num(v));
const of = (a: unknown, b: unknown) => `${num(a)} of ${num(b)}`;
const pair = (a: string, b: string) => `${a} / ${b}`;
/** "pg_dump of prod taken before each apply (control/evidence.py backup_prod)" reads as its first half on a tile. */
const plainWhat = (what: string | null | undefined) => (what ?? '').split(' (')[0];

type Fact = [string, string];

interface Service {
  id: string;
  name: string;
  role: string;
  figure: string;
  unit: string;
  facts: Fact[];
  source: string;
}

/** Every value is read from bench/vultr.json as bench/vultr_usage.py wrote it. This file formats and adds nothing up. */
function services(d: VultrUsage): Service[] {
  const out: Service[] = [];
  const inf = d.inference;
  const sha = d.benchmark?.code_sha256?.slice(0, 12);
  const files = d.benchmark?.files?.length;
  if (inf?.tokens !== undefined) {
    out.push({
      id: 'inference',
      name: 'Serverless Inference',
      role: 'Every model call: the planner and its retries, the explainer, the second reader that checks a plan still does what was asked.',
      figure: big(inf.tokens),
      unit: 'tokens in the final benchmark',
      facts: [
        ['Runs', num(inf.runs)],
        ['Cost, priced from the model list', dollars(inf.cost_usd)],
        ['Models it used', num(inf.models_used)],
        ['Planner calls, at least', num(inf.calls_at_least?.planner)],
        ['Prompt / completion tokens', pair(num(inf.prompt_tokens), num(inf.completion_tokens))],
      ],
      source: `bench/runs*.jsonl · ${num(files)} files of code ${sha ?? '–'}`,
    });
  }
  const vm = d.microvms;
  if (vm?.total !== undefined) {
    const facts: Fact[] = [
      ['First run of each plan', num(vm.rehearsals)],
      ['Second clone, to reproduce it', num(vm.reproductions)],
      ['Clone boot, p50 / p95', pair(ms(vm.clone_boot_ms?.p50), ms(vm.clone_boot_ms?.p95))],
      ['Containment record complete', of(vm.containment_complete, vm.rehearsals)],
    ];
    if (vm.redteam?.attacks) facts.push(['Red-team attacks contained', of(vm.redteam.contained, vm.redteam.attacks)]);
    out.push({
      id: 'vx1',
      name: 'VX1 Cloud Compute',
      role: 'Each plan runs first on a throwaway clone of prod, in its own microVM with no network card, and the VM is destroyed after.',
      figure: num(vm.total),
      unit: 'microVM rehearsals in the final benchmark',
      facts,
      source: 'bench/runs*.jsonl, shadow_run mode · second clones counted from verdicts',
    });
  }
  const pg = d.postgres;
  if (pg?.benchmark?.databases_created !== undefined || pg?.cluster) {
    const c = pg?.cluster;
    const facts: Fact[] = [];
    if (c?.version) facts.push(['Engine', `PostgreSQL ${c.version}`]);
    if (isNum(c?.vcpus) && isNum(c?.ram_mb)) facts.push(['Node', `${num(c.vcpus)} vCPU · ${num(c.ram_mb / 1024)} GB · ${c.region ?? ''}`.trim()]);
    if (c?.status) facts.push(['Status', c.status]);
    if (c?.in_vpc !== undefined) facts.push(['Reached over', c.in_vpc ? 'the private VPC' : 'the public network']);
    if (isNum(pg?.benchmark?.drop_failed)) facts.push(['Drops that failed', num(pg.benchmark.drop_failed)]);
    out.push({
      id: 'postgres',
      name: 'Managed PostgreSQL',
      role: "Holds the demo's production data. Postgres measures each plan's blast radius, and the benchmark gave every SQL run a fresh database of its own.",
      figure: num(pg?.benchmark?.databases_created),
      unit: 'databases created and dropped by the benchmark',
      facts,
      source: ['bench/runs*.jsonl', c?.source ? 'GET /v2/databases' : null].filter(Boolean).join(' · '),
    });
  }
  const os = d.object_storage;
  if (os?.objects !== undefined) {
    out.push({
      id: 'object-storage',
      name: 'Object Storage',
      role: 'A signed evidence bundle for every run, and a backup of prod taken before every apply.',
      figure: num(os.objects),
      unit: 'objects in the evidence bucket',
      facts: [
        ...(os.by_prefix ?? []).map((p): Fact => [`${p.prefix}/ · ${plainWhat(p.what)}`, `${num(p.objects)} · ${bytes(p.bytes)}`]),
        ['Total size', bytes(os.bytes)],
      ],
      source: `S3 ListObjectsV2 · ${os.bucket ?? ''}`,
    });
  }
  const res = d.resources;
  if (res?.count) {
    const control = res.instances?.find((i) => i.label?.endsWith('control'));
    const vpc = res.vpcs?.[0];
    const facts: Fact[] = [];
    if (control) facts.push(['Control plane VM', [control.plan, control.region, control.status].filter(Boolean).join(' · ')]);
    if (vpc?.v4_subnet) facts.push(['Private network', `${vpc.v4_subnet}/${num(vpc.v4_subnet_mask)}`]);
    if (res.firewalls) facts.push(['Firewall groups / rules', pair(num(res.firewalls.length), num(res.firewall_rules))]);
    out.push({
      id: 'network',
      name: 'Cloud Compute, VPC, firewalls',
      role: 'The API, web app and MCP server, on the only machine that holds the prod credential. The runner answers to it alone, over the VPC.',
      figure: num(res.count),
      unit: 'resources, each tagged shadowrun',
      facts,
      source: 'GET /v2/instances, /v2/vpcs, /v2/firewalls',
    });
  }
  const billed = d.spend?.billed;
  if (billed?.total_usd !== undefined) {
    out.push({
      id: 'billed',
      name: 'Billed by Vultr',
      role: 'What Vultr has billed this account so far, by product. Inference here is every call made while building and testing, not only the benchmark.',
      figure: dollars(billed.total_usd),
      unit: 'billed so far this month',
      facts: (billed.by_product ?? []).map((p): Fact => [p.product.replace(/^Vultr /, ''), dollars(p.usd)]),
      source: 'GET /v2/billing/pending-charges',
    });
  }
  return out;
}

function Tile({ s }: { s: Service }) {
  return (
    <li className="vr-tile" id={`vultr-${s.id}`}>
      <Label>{s.name}</Label>
      <p className="vr-role">{s.role}</p>
      <p className="vr-figure">
        <span className="t-num-l">{s.figure}</span>
        <span className="vr-unit">{s.unit}</span>
      </p>
      {s.facts.length > 0 && (
        <dl className="vr-facts">
          {s.facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className="mono">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <span className="t-caption vr-source">{s.source}</span>
    </li>
  );
}

function Models({ d }: { d: VultrUsage }) {
  const models = d.models ?? [];
  if (!models.length) return null;
  return (
    <div className="vr-models">
      <div className="vr-models-head">
        <Label>Which model does what</Label>
        <span className="t-caption">
          control/settings.py · prices per million tokens from {d.catalogue?.source?.replace(/ \(no key\)$/, '') ?? 'the model list'}
          {isNum(d.catalogue?.models_listed) ? `, which lists ${num(d.catalogue.models_listed)} models` : ''}
        </span>
      </div>
      <ul className="vr-model-list">
        {models.map((m) => (
          <li key={m.model} className="vr-model">
            <span className="vr-model-name mono">{m.model}</span>
            <span className="vr-model-jobs">{m.jobs.map((j) => j.job).join(' · ')}</span>
            <span className="vr-model-price mono">
              {m.listed ? `${dollars(m.usd_per_million_prompt)} in / ${dollars(m.usd_per_million_completion)} out` : 'not in the model list'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Each Vultr service, what it does in Shadow Run, and its measured numbers with where they came from. `compact` keeps the
 * first two facts per service and leaves out the model table, for the landing page; the Results page shows everything. */
export function VultrReceipts({ data, n, head, compact: short = false }: { data: VultrUsage; n?: number; head?: ReactNode; compact?: boolean }) {
  const list = services(data);
  if (!list.length) return null;
  const parsed = data.at ? Date.parse(data.at) / 1000 : null;
  const missing = Object.keys(data.errors ?? {});
  return (
    <div className="vr">
      {head}
      <ol className="vr-grid">
        {list.map((s) => (
          <Tile key={s.id} s={short ? { ...s, facts: s.facts.slice(0, 2) } : s} />
        ))}
      </ol>
      {!short && <Models d={data} />}
      <p className="t-caption vr-foot">
        {sourceLine({ n, measured: isNum(parsed) ? parsed : null, extra: 'bench/vultr.json · GET requests and one bucket listing, nothing changed' })}
        {data.rerun ? ` · re-run: ${data.rerun}` : ''}
        {missing.length ? ` · not measured this time: ${missing.join(', ')}` : ''}
      </p>
    </div>
  );
}
