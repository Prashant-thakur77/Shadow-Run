import type { AttackDef, Audit, Candidate, Challenge, EvasionFacts, Gauntlet, GauntletPublished, GuardrailDraft, Health, Incident, Inspect, Market, Me, ProdChecksum, PublicInfo, Race, Receipt, RecordedRace, RedTeamRun, Run, RunFeed, RunSummary, Target, VultrUsage } from './types';
import { rememberRun } from '../lib/myRuns';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let bearer: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setBearer(token: string | null) {
  bearer = token;
}

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

// Dev-only fixture mode. The dynamic import keeps every fixture out of the production bundle.
type FixtureResolver = (method: string, path: string) => Promise<{ status: number; body: unknown }>;
let fixtureResolver: Promise<FixtureResolver | null> | null = null;
function fixtures(): Promise<FixtureResolver | null> {
  if (!import.meta.env.DEV) return Promise.resolve(null);
  if (!fixtureResolver) {
    fixtureResolver = new URLSearchParams(location.search).has('fixture')
      ? import('../dev/fixtures').then((m) => m.resolveFixture)
      : Promise.resolve(null);
  }
  return fixtureResolver;
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : JSON.stringify(d)))
        .join('; ');
    }
    if (detail !== undefined) return JSON.stringify(detail);
  }
  return fallback;
}

export interface RawResponse {
  status: number;
  ok: boolean;
  body: unknown;
  message: string;
}

/** Sends a request and always resolves. Used directly by the negative controls, which expect refusals. */
export async function raw(method: string, path: string, body?: unknown, token?: string | null): Promise<RawResponse> {
  const resolver = await fixtures();
  if (resolver) {
    const res = await resolver(method, path);
    const ok = res.status >= 200 && res.status < 300;
    return { status: res.status, ok, body: res.body, message: messageFrom(res.body, ok ? 'OK' : `HTTP ${res.status}`) };
  }
  const headers: Record<string, string> = {};
  const tok = token === undefined ? bearer : token;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { status: 0, ok: false, body: null, message: `Could not reach the server: ${(e as Error).message}` };
  }
  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    body: parsed,
    message: messageFrom(parsed, res.ok ? 'OK' : `HTTP ${res.status}${typeof parsed === 'string' ? `: ${parsed.slice(0, 200)}` : ''}`),
  };
}

async function call<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  const res = await raw(method, path, body, token);
  if (!res.ok) {
    if (res.status === 401 && token === undefined) onUnauthorized?.();
    throw new ApiError(res.status, res.message);
  }
  return res.body as T;
}

/** Runs started from this browser are the ones its Recent runs list leads with. */
function mine<T extends { id: string }>(run: T): T {
  rememberRun(run.id);
  return run;
}

export const api = {
  login: (username: string, password: string) =>
    call<{ username: string; name?: string; token: string }>('POST', '/api/login', { username, password }, null),
  logout: () => call<unknown>('POST', '/api/logout', {}, null),
  publicInfo: () => call<PublicInfo>('GET', '/api/public', undefined, null),
  market: () => call<Market>('GET', '/api/market', undefined, null),
  evasion: () => call<EvasionFacts>('GET', '/api/evasion', undefined, null),
  vultr: () => call<VultrUsage>('GET', '/api/vultr', undefined, null),
  demoEnter: () => call<{ username: string; name?: string; token: string; others?: Record<string, string> }>('POST', '/api/demo/enter', {}, null),
  me: (token?: string | null) => call<Me>('GET', '/api/me', undefined, token === undefined ? undefined : token),

  health: () => call<Health>('GET', '/api/health'),
  prodChecksum: (targetId: string) => call<ProdChecksum>('GET', `/api/prod-checksum?target_id=${encodeURIComponent(targetId)}`),

  runs: (limit = 15) => call<RunSummary[]>('GET', `/api/runs?limit=${limit}`),
  runFeed: (ids: string[]) => call<RunFeed>('GET', `/api/runs/feed?ids=${encodeURIComponent(ids.join(','))}`),
  run: (id: string) => call<Run>('GET', `/api/runs/${encodeURIComponent(id)}`),
  startRun: (body: { task?: string; steps?: { type: 'sql' | 'shell'; cmd: string; why?: string }[]; target_id?: string; source?: string; from_race?: string }) =>
    call<{ id: string; status: string }>('POST', '/api/runs', { source: 'web', ...body }).then(mine),
  raceStart: (task: string) =>
    call<Race>('POST', '/api/race', { task }).then((race) => {
      rememberRun(race.alone);
      rememberRun(race.through);
      return race;
    }),
  race: (id: string) => call<Race>('GET', `/api/race/${encodeURIComponent(id)}`),
  raceRecorded: () => call<RecordedRace>('GET', '/api/race/recorded'),
  approve: (id: string, c: Pick<Challenge, 'plan_hash' | 'guardrails_hash' | 'report_hash' | 'nonce'>) =>
    call<Run>('POST', `/api/runs/${encodeURIComponent(id)}/approve`, {
      plan_hash: c.plan_hash,
      guardrails_hash: c.guardrails_hash,
      report_hash: c.report_hash,
      nonce: c.nonce,
    }),
  reject: (id: string, reason: string) => call<Run>('POST', `/api/runs/${encodeURIComponent(id)}/reject`, { reason }),
  apply: (id: string, driftCheck = true) =>
    call<Run>('POST', `/api/runs/${encodeURIComponent(id)}/apply`, { drift_check: driftCheck }),
  rehearseAgain: (id: string) => call<{ id: string; status: string }>('POST', `/api/runs/${encodeURIComponent(id)}/rehearse-again`).then(mine),

  undoStatements: (id: string) => call<{ statements?: string[] }>('GET', `/api/runs/${encodeURIComponent(id)}/undo`),
  undo: (id: string) => call<{ id: string; status: string }>('POST', `/api/runs/${encodeURIComponent(id)}/undo`).then(mine),
  learn: (id: string, reason: string) => call<Candidate>('POST', `/api/runs/${encodeURIComponent(id)}/learn`, { reason }),
  acceptCandidate: (id: string, targetId: string) =>
    call<Target>('POST', `/api/guardrails/candidates/${encodeURIComponent(id)}/accept?target_id=${encodeURIComponent(targetId)}`),

  gauntletStart: (targetId: string) => call<Gauntlet>('POST', `/api/targets/${encodeURIComponent(targetId)}/gauntlet`),
  gauntletPublished: () => call<GauntletPublished>('GET', '/api/gauntlet/published'),
  gauntletReplay: (id: string) => call<Gauntlet>('POST', `/api/gauntlet/${encodeURIComponent(id)}/replay`),
  gauntletList: (limit = 1) => call<Gauntlet[]>('GET', `/api/gauntlet?limit=${limit}`),

  incidents: () => call<Incident[]>('GET', '/api/incidents'),
  replayIncident: (id: string) => call<{ id: string; status: string }>('POST', `/api/incidents/${encodeURIComponent(id)}/replay`).then(mine),
  receipts: () => call<{ items?: Receipt[]; note?: string }>('GET', '/api/receipts'),

  demoReset: (targetId: string) => call<{ ok?: boolean }>('POST', `/api/demo/reset?target_id=${encodeURIComponent(targetId)}`),

  redteamStart: () => call<RedTeamRun>('POST', '/api/redteam'),
  redteamList: (limit = 1) => call<RedTeamRun[]>('GET', `/api/redteam?limit=${limit}`),
  redteamAttacks: () => call<AttackDef[]>('GET', '/api/redteam/attacks'),

  results: () => call<Record<string, unknown>>('GET', '/api/results'),
  audit: (after: number, limit: number) => call<Audit>('GET', `/api/audit?after=${after}&limit=${limit}`),

  targets: () => call<Target[]>('GET', '/api/targets'),
  inspect: (id: string) => call<Inspect>('GET', `/api/targets/${encodeURIComponent(id)}/inspect`),
  draftGuardrails: (id: string) =>
    call<{ drafts?: GuardrailDraft[]; model?: string }>('POST', `/api/targets/${encodeURIComponent(id)}/guardrails/draft`),
};

export function errorText(e: unknown): string {
  // The one refusal a visitor can meet by simply waiting too long, so it says what to do next.
  if (e instanceof ApiError && e.status === 410) return 'The approval window closed. Rehearse again to get a new one.';
  if (e instanceof ApiError) return e.status ? `${e.status}: ${e.message}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Tells the prod indicator to re-measure, after anything that may have written to prod. */
export function notifyProdChanged() {
  window.dispatchEvent(new Event('sr:prod-changed'));
}
