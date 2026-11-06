// Drives the real UI against the live API through the dev proxy.
// Passwords come from the environment, are typed into the page, and are never logged or written.
//   set -a; source <(grep -E '^SHADOWRUN_(JUDGE|REVIEWER)_PASSWORD=' ../.env); set +a; node scripts/live.mjs flow
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.SHOTS_BASE ?? 'http://127.0.0.1:5173';
const OUT = fileURLToPath(new URL('../.shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const JUDGE = process.env.SHADOWRUN_JUDGE_PASSWORD;
const REVIEWER = process.env.SHADOWRUN_REVIEWER_PASSWORD;
if (!JUDGE || !REVIEWER) throw new Error('Set SHADOWRUN_JUDGE_PASSWORD and SHADOWRUN_REVIEWER_PASSWORD.');

const which = new Set(process.argv.slice(2));
const all = which.size === 0;
const want = (name) => all || which.has(name);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();

async function open(viewport, { mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/40[139]|410|429/.test(m.text())) log('CONSOLE', m.text().slice(0, 240));
  });
  return { ctx, page };
}

async function shot(page, name, { full = false } = {}) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}live-${name}.png`, fullPage: full });
}

async function signIn(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.getByText('Sign in', { exact: true }).first().waitFor();
  await page.getByLabel('Password for judge').fill(JUDGE);
  await page.getByLabel('Password for reviewer').fill(REVIEWER);
  await page.getByRole('button', { name: 'Sign in as judge' }).click();
  await page.getByRole('heading', { name: 'Give the agent a task' }).waitFor();
  const stored = await page.evaluate(() => JSON.stringify(Object.values(sessionStorage)));
  const leaked = stored.includes(JUDGE) || stored.includes(REVIEWER);
  log('signed in. password kept in storage:', leaked);
  if (leaked) throw new Error('A password reached sessionStorage.');
}

async function status(page) {
  return (await page.locator('.runhead-word').innerText()).trim();
}

async function waitStatus(page, words, timeout = 120000) {
  const list = Array.isArray(words) ? words : [words];
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeout) {
    const now = await status(page).catch(() => '');
    if (now !== last) {
      log(`  status: ${now}`);
      last = now;
    }
    if (list.includes(now)) return now;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${list.join(' or ')}, still ${last}`);
}

async function startSql(page, label) {
  await page.getByRole('link', { name: 'New task' }).first().click();
  await page.getByRole('button', { name: 'SQL plan' }).click();
  await page.getByRole('button', { name: new RegExp(label) }).click();
  await page.getByRole('button', { name: 'Rehearse on a clone' }).click();
  await page.locator('.runhead-word').waitFor();
  log(`  run: ${page.url().split('/').pop()}`);
}

async function tryIt(page, title) {
  // The result is written to the row, or to the list below once the run has moved on and the row is gone.
  const all = page.locator('#break .breakres');
  const before = await all.count();
  await page.locator('.break', { hasText: title }).getByRole('button', { name: 'Try it' }).click();
  const start = Date.now();
  while ((await all.count()) <= before && Date.now() - start < 60000) await page.waitForTimeout(150);
  const res = page.locator('#break .breakres', { hasText: new RegExp(title.includes('apply') ? '/apply' : title.includes('Change') ? '/demo/drift' : '/approve') }).last();
  const code = await res.locator('.breakres-code').innerText();
  const verdict = await res.locator('.breakres-verdict').innerText();
  const msg = await res.locator('.breakres-msg').innerText();
  log(`  ${title}: ${code} ${verdict.trim()} | ${msg.slice(0, 110)}`);
}

if (want('flow')) {
  log('FLOW: approve, negative controls, drift, rollback, commit');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await signIn(page);
  await shot(page, 'home-d', { full: true });

  await startSql(page, 'Suspend long-gone users');
  await shot(page, 'run-inprogress-d');
  await waitStatus(page, 'Awaiting approval');
  await shot(page, 'run-awaiting-requester-d');

  await tryIt(page, 'Approve your own run');
  await tryIt(page, 'Approve with a tampered plan hash');
  await tryIt(page, 'Approve with a tampered report');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await shot(page, 'break-refusals-d', { full: false });

  await page.getByRole('button', { name: 'Switch to reviewer' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  log('  switched to reviewer, can approve');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await shot(page, 'decision-reviewer-d');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await waitStatus(page, 'Approved');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await shot(page, 'run-approved-d');

  await tryIt(page, 'Replay the approval');
  await tryIt(page, 'Change prod behind its back');
  await page.locator('#break').scrollIntoViewIfNeeded();
  await shot(page, 'break-after-approval-d');
  await tryIt(page, 'Now apply, drift check on');
  await waitStatus(page, 'Drift detected');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await shot(page, 'run-drift-d');
  await page.locator('#break').scrollIntoViewIfNeeded();
  await shot(page, 'break-after-drift-d');

  log('Rehearse again, as reviewer, so judge has to approve');
  await page.getByRole('button', { name: 'Rehearse again' }).click();
  await page.waitForTimeout(800);
  await waitStatus(page, 'Awaiting approval');
  log(`  run: ${page.url().split('/').pop()}`);
  await page.getByRole('button', { name: 'Switch to judge' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await waitStatus(page, 'Approved');
  await tryIt(page, 'Change prod behind its back');
  await tryIt(page, 'Now apply, drift check off');
  await waitStatus(page, 'Rolled back');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await shot(page, 'run-rolled-back-d');

  log('Rehearse again, as judge, then a clean apply');
  await page.getByRole('button', { name: 'Rehearse again' }).click();
  await page.waitForTimeout(800);
  await waitStatus(page, 'Awaiting approval');
  log(`  run: ${page.url().split('/').pop()}`);
  await page.getByRole('button', { name: 'Switch to reviewer' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await waitStatus(page, 'Approved');
  await page.getByRole('button', { name: 'Apply to prod' }).click();
  await waitStatus(page, 'Applied');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await shot(page, 'run-applied-d');
  await page.locator('.runhead').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  await shot(page, 'run-applied-top-d');
  await ctx.close();
}

if (want('agent')) {
  log('AGENT: example task with retries, on a phone');
  const { ctx, page } = await open({ width: 390, height: 844 }, { mobile: true });
  await signIn(page);
  await page.getByRole('button', { name: /^Archive users/ }).click();
  await page.getByRole('button', { name: 'Rehearse on a clone' }).click();
  await page.locator('.runhead-word').waitFor();
  log(`  run: ${page.url().split('/').pop()}`);
  let n = 0;
  let last = '';
  const start = Date.now();
  while (Date.now() - start < 150000) {
    const s = await status(page);
    const events = await page.locator('.eventlog li').count().catch(() => 0);
    const key = `${s}/${events}`;
    if (key !== last) {
      log(`  ${s}, ${events} events`);
      last = key;
      if (n < 6) await shot(page, `agent-${++n}-m`);
    }
    if (['Awaiting approval', 'Blocked', 'Error', 'Applied'].includes(s)) break;
    await page.waitForTimeout(400);
  }
  log(`  final: ${await status(page)}, url ${page.url()}`);
  const story = await page.locator('.story-step').allInnerTexts();
  log('  story:', JSON.stringify(story.map((t) => t.replace(/\n/g, ' '))));
  await page.locator('.runhead').scrollIntoViewIfNeeded();
  await shot(page, 'agent-final-m', { full: false });
  await ctx.close();
}

if (want('other')) {
  log('OTHER: auto-applied and gate-blocked plans');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await signIn(page);
  await startSql(page, 'Flip one feature flag');
  await waitStatus(page, ['Applied', 'Blocked', 'Awaiting approval', 'Error']);
  await page.locator('.runhead').scrollIntoViewIfNeeded();
  await shot(page, 'auto-d');
  await startSql(page, 'Try to escape the transaction');
  await waitStatus(page, ['Blocked', 'Error']);
  await shot(page, 'gate-d', { full: true });
  await ctx.close();
}

if (want('host')) {
  log('HOST: Linux server target, shell plan, drift, then an agent task');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByRole('button', { name: 'Linux server' }).click();
  await page.waitForTimeout(1500);
  log('  indicator', await page.locator('.prod').innerText());
  await shot(page, 'host-home-d');
  await page.getByRole('button', { name: 'Shell plan' }).click();
  await page.getByRole('button', { name: /Clear only thumbnails/ }).click();
  await page.getByRole('button', { name: 'Rehearse on a clone' }).click();
  await page.locator('.runhead-word').waitFor();
  await waitStatus(page, ['Awaiting approval', 'Blocked', 'Applied', 'Error']);
  await shot(page, 'host-awaiting-d');
  await page.getByRole('button', { name: 'Switch to reviewer' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await waitStatus(page, 'Approved');
  await tryIt(page, 'Replay the approval');
  await tryIt(page, 'Change prod behind its back');
  await tryIt(page, 'Now apply, drift check on');
  await waitStatus(page, 'Drift detected');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await shot(page, 'host-drift-d');
  await page.getByRole('link', { name: 'New task' }).first().click();
  await page.getByRole('button', { name: 'Linux server' }).click();
  await page.getByRole('button', { name: /^Free up space in/ }).click();
  await page.getByRole('button', { name: 'Rehearse on a clone' }).click();
  await page.locator('.runhead-word').waitFor();
  log(`  agent run: ${page.url().split('/').pop()}`);
  await waitStatus(page, ['Awaiting approval', 'Blocked', 'Applied', 'No change', 'Error'], 180000);
  log('  story', JSON.stringify((await page.locator('.story-step').allInnerTexts()).map((t) => t.replace(/\n/g, ' '))));
  await page.locator('#blast').scrollIntoViewIfNeeded();
  await shot(page, 'host-agent-d');
  await page.goto(BASE + '/guardrails', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Linux server' }).click();
  await page.waitForTimeout(1000);
  await shot(page, 'host-target-d');
  await ctx.close();
}

if (want('redteam')) {
  log('RED TEAM');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByRole('link', { name: 'Red team' }).click();
  await page.getByRole('button', { name: 'Run the red team' }).waitFor();
  await page.waitForTimeout(800);
  await shot(page, 'redteam-before-d');
  await page.getByRole('button', { name: 'Run the red team' }).click();
  let lastScore = '';
  let shots = 0;
  const start = Date.now();
  while (Date.now() - start < 300000) {
    const score = await page.locator('.rt-score').innerText().catch(() => '');
    const running = await page.getByRole('button', { name: 'Running' }).count();
    if (score !== lastScore) {
      log(`  ${score}, running=${running}`);
      lastScore = score;
      if (shots++ < 3) await shot(page, `redteam-progress-${shots}-d`);
    }
    if (!running && Date.now() - start > 3000) break;
    await page.waitForTimeout(500);
  }
  await page.locator('.rt-prod').scrollIntoViewIfNeeded();
  await shot(page, 'redteam-done-climax-d');
  await shot(page, 'redteam-done-d', { full: true });
  await ctx.close();
}

if (want('pages')) {
  log('PAGES: drafts, audit, results, both sizes');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByRole('link', { name: 'Guardrails' }).click();
  await page.getByRole('button', { name: 'Draft with the model' }).waitFor();
  await page.getByRole('button', { name: 'Draft with the model' }).click();
  await page.locator('.drafts .guardrail, .drafts .notice, .drafts .notmeasured').first().waitFor({ timeout: 180000 });
  log('  drafts:', await page.locator('.drafts .guardrail').count());
  await page.locator('.drafts').scrollIntoViewIfNeeded();
  await shot(page, 'drafts-d');
  await page.getByRole('link', { name: 'Audit' }).click();
  await page.locator('.chain').waitFor();
  await page.waitForTimeout(500);
  await shot(page, 'audit-d');
  // A real sample for the dev fixture mode, so the audit page can be checked offline.
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('sr.session')).tokens.judge);
  const audit = await page.evaluate(async (t) => {
    const head = await (await fetch('/api/audit?limit=1', { headers: { Authorization: `Bearer ${t}` } })).json();
    const total = head.chain.events;
    return (await fetch(`/api/audit?after=${Math.max(0, total - 40)}&limit=40`, { headers: { Authorization: `Bearer ${t}` } })).json();
  }, token);
  writeFileSync(new URL('../fixtures/audit.json', import.meta.url), JSON.stringify(audit, null, 1));
  await page.getByRole('link', { name: 'Results' }).click();
  await page.locator('.emptystate, .scroll-x, .notmeasured').first().waitFor();
  await shot(page, 'results-d');
  await ctx.close();

  const m = await open({ width: 390, height: 844 }, { mobile: true });
  await signIn(m.page);
  for (const [name, link] of [['redteam', 'Red team'], ['guardrails', 'Guardrails'], ['audit', 'Audit'], ['results', 'Results']]) {
    await m.page.getByRole('link', { name: link }).click();
    await m.page.waitForLoadState('networkidle');
    await m.page.waitForTimeout(500);
    const over = await m.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    log(`  ${name} at 390: page overflow ${over}px`);
    await shot(m.page, `${name}-m`);
  }
  await m.ctx.close();
}

if (want('smoke')) {
  log('SMOKE: production build, read only');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await signIn(page);
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('sr.session')).tokens.judge);
  const runs = await page.evaluate(async (t) => (await fetch('/api/runs?limit=60', { headers: { Authorization: `Bearer ${t}` } })).json(), token);
  const cascade = runs.find((r) => (r.rows_via_cascade ?? 0) > 0);
  log('  run with a cascade:', cascade?.id);
  if (cascade) {
    await page.goto(`${BASE}/runs/${cascade.id}?fixture=run-applied`, { waitUntil: 'domcontentloaded' });
    await page.locator('.tnode').first().waitFor({ timeout: 20000 });
    log('  cascade nodes:', await page.locator('.tnode').count(), '| plan nodes:', await page.locator('.snode').count(), '| fixture ignored:', (await page.locator('.runhead-word').innerText()) !== 'Applied' || cascade.status === 'applied');
    await page.getByText(/^Sample rows, before and after/).click();
    await page.locator('.sample-tables summary').first().click();
    await page.locator('.sample').first().waitFor({ timeout: 20000 });
    log('  diff viewer rows:', await page.locator('.sample').count());
  }
  await page.goto(`${BASE}/results`, { waitUntil: 'domcontentloaded' });
  await page.locator('.emptystate, .data, .notmeasured').first().waitFor();
  log('  results page ok');
  await ctx.close();
}

if (want('reset')) {
  log('RESET: reseeding demo prod through the page');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await signIn(page);
  await page.getByRole('link', { name: 'Guardrails' }).click();
  for (const [tab, button] of [['Linux server', 'Reseed demo server'], ['Database', 'Reseed demo prod']]) {
    await page.getByRole('button', { name: tab }).click();
    await page.getByRole('button', { name: button }).waitFor();
    await page.getByRole('button', { name: button }).click();
    await page.locator('.democtl [role=status]').waitFor({ timeout: 180000 });
    log('  ', await page.locator('.democtl [role=status]').innerText());
    await page.waitForTimeout(1500);
    log('   prod now', await page.locator('.prod-hash').innerText());
  }
  await ctx.close();
}

await browser.close();
log('done');
