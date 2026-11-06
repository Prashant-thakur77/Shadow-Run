// Drives the real UI against the live API through the dev proxy.
// Passwords come from the environment, are typed into the page, and are never logged or written.
//   node scripts/live.mjs landing trap learn undo incidents gauntlet phone reset
// The older steps sign in with passwords, from the environment if set:
//   set -a; source <(grep -E '^SHADOWRUN_(JUDGE|REVIEWER)_PASSWORD=' ../.env); set +a; node scripts/live.mjs flow
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.SHOTS_BASE ?? 'http://127.0.0.1:5173';
const OUT = fileURLToPath(new URL('../.shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });
const JUDGE = process.env.SHADOWRUN_JUDGE_PASSWORD;
const REVIEWER = process.env.SHADOWRUN_REVIEWER_PASSWORD;

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

async function guest(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.getByRole('heading', { name: 'Give the agent a task' }).waitFor();
}

async function signIn(page) {
  if (!JUDGE || !REVIEWER) return guest(page);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.getByText('Sign in with a password').click();
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

async function learnOn(page) {
  await page.getByRole('button', { name: 'Turn this into a guardrail' }).click();
  await page.waitForTimeout(800);
  await shot(page, 'learn-busy-d');
  await page.locator('.candidate, .learn .notice').first().waitFor({ timeout: 180000 });
  await page.locator('.candidate').scrollIntoViewIfNeeded().catch(() => {});
  await shot(page, 'learn-candidate-d');
  log('  candidate:', (await page.locator('.candidate-name').innerText().catch(() => 'none')));
  log('  proofs:', (await page.locator('.candidate .proofrows').innerText().catch(() => '')).replace(/\s+/g, ' '));
  const accept = page.getByRole('button', { name: 'Accept this guardrail' });
  if (await accept.count()) {
    await accept.click();
    await page.getByRole('button', { name: 'Rehearse this plan again' }).waitFor({ timeout: 30000 });
    await page.locator('.candidate').scrollIntoViewIfNeeded();
    await shot(page, 'learn-accepted-d');
    await page.getByRole('button', { name: 'Rehearse this plan again' }).click();
    await page.waitForTimeout(1000);
    await waitStatus(page, ['Awaiting approval', 'Blocked', 'Applied', 'No change', 'Error'], 200000);
    log('  rehearsed again:', page.url().split('/').pop());
    await page.waitForTimeout(600);
    await shot(page, 'learn-rehearsed-d');
    await page.goto(BASE + '/guardrails', { waitUntil: 'domcontentloaded' });
    await page.locator('.learned').first().waitFor({ timeout: 20000 });
    await page.locator('.learned').first().scrollIntoViewIfNeeded();
    await shot(page, 'learn-frozen-mark-d');
  } else {
    log('  not proved, so no accept was offered');
  }
}

const shared = { trapRun: null };

if (want('landing')) {
  log('LANDING');
  for (const [name, vp, mobile] of [['d', { width: 1440, height: 900 }, false], ['m', { width: 390, height: 844 }, true]]) {
    const { ctx, page } = await open(vp, { mobile });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await shot(page, `landing-${name}`, { full: true });
    await page.getByRole('button', { name: 'Continue as guest' }).click();
    await page.getByRole('heading', { name: 'Give the agent a task' }).waitFor();
    await page.waitForLoadState('networkidle');
    const tokens = await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('sr.session')).tokens));
    log(`  ${name}: signed in, tokens for ${tokens.join(', ')}, identity ${await page.locator('.seg-btn.is-on').first().innerText()}`);
    await shot(page, `home-${name}`);
    await page.getByRole('button', { name: 'reviewer', exact: true }).click();
    await page.waitForTimeout(600);
    log(`  ${name}: one click later, identity ${await page.locator('.identity .seg-btn.is-on').innerText()}`);
    await ctx.close();
  }
}

if (want('trap')) {
  log('TRAP: Start here, then read the panel');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await guest(page);
  if (process.env.TRAP_RUN) {
    await page.goto(`${BASE}/runs/${process.env.TRAP_RUN}`, { waitUntil: 'domcontentloaded' });
  } else {
    await page.getByRole('button', { name: /Run the trap task/ }).click();
  }
  await page.locator('.runhead-word').waitFor();
  log(`  run ${page.url().split('/').pop()}`);
  await waitStatus(page, ['Awaiting approval', 'Blocked', 'Applied', 'No change', 'Error'], 240000);
  shared.trapRun = page.url();
  await page.waitForTimeout(600);
  await shot(page, 'trap-top-d');
  log('  hero:', (await page.locator('.ww-hero').innerText().catch(() => 'no panel')).replace(/\n/g, ' | '));
  log('  table:', (await page.locator('.ww-table').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400));
  await page.locator('#compare').scrollIntoViewIfNeeded();
  await shot(page, 'trap-compare-d');
  await page.locator('.bizmetrics').scrollIntoViewIfNeeded();
  await shot(page, 'trap-metrics-d');
  await page.locator('.cps').scrollIntoViewIfNeeded();
  await page.locator('.cp').last().scrollIntoViewIfNeeded();
  await shot(page, 'trap-record-d');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await shot(page, 'trap-decision-d');
  if (await page.getByText('The undo statements').count()) {
    await page.getByText('The undo statements').click();
    await page.locator('.undo .undo-sql, .undo .fold-body .muted').first().waitFor({ timeout: 20000 });
    log('  undo statements shown:', await page.locator('.undo-sql').count());
    await page.locator('.undo').scrollIntoViewIfNeeded();
    await shot(page, 'trap-undo-d');
  } else {
    log('  no undo plan:', (await page.locator('.undo').innerText()).replace(/\n/g, ' '));
  }
  await page.locator('#commands').scrollIntoViewIfNeeded();
  await page.getByRole('heading', { name: 'Cost by phase' }).scrollIntoViewIfNeeded();
  await shot(page, 'trap-cost-d');

  // Learn from a rejection, on this same run.
  log('LEARN: reject as the reviewer, then turn the reason into a rule');
  await page.locator('#decision').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Switch to reviewer' }).click();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  const reason = process.env.LEARN_REASON ?? 'Users with an open support ticket are still customers. Never retire them.';
  await page.getByLabel('Reason for rejecting').fill(reason);
  await page.getByRole('button', { name: 'Reject this run' }).click();
  await waitStatus(page, 'Rejected');
  await page.locator('#learn').scrollIntoViewIfNeeded();
  log('  prefilled:', (await page.locator('.learn-reason').inputValue()).slice(0, 80));
  await learnOn(page);
  await ctx.close();
}

if (want('learn')) {
  log('LEARN: a reason that should prove');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await guest(page);
  await page.goto(`${BASE}/runs/${process.env.LEARN_RUN}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#learn').waitFor();
  await page.locator('#learn').scrollIntoViewIfNeeded();
  await page.locator('.learn-reason').fill(process.env.LEARN_REASON ?? 'Retiring more than five percent of live users in one change is never routine. Keep the count of live users within five percent of what it was.');
  await learnOn(page);
  await ctx.close();
}

if (want('undo')) {
  log('UNDO: apply a plan, then undo it');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await guest(page);
  await page.getByRole('button', { name: 'SQL plan' }).click();
  await page.getByRole('button', { name: /Suspend long-gone users/ }).click();
  await page.getByRole('button', { name: 'Rehearse on a clone' }).click();
  await page.locator('.runhead-word').waitFor();
  await waitStatus(page, ['Awaiting approval', 'Blocked', 'Applied', 'Error'], 200000);
  const original = page.url().split('/').pop();
  await page.getByRole('button', { name: 'Switch to reviewer' }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await waitStatus(page, 'Approved');
  await page.getByRole('button', { name: 'Apply to prod' }).click();
  await waitStatus(page, 'Applied');
  await page.locator('.undo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await shot(page, 'undo-applied-d');
  await page.getByRole('button', { name: 'Undo this change' }).click();
  await page.waitForTimeout(1200);
  log(`  undo run ${page.url().split('/').pop()} of ${original}`);
  await waitStatus(page, ['Awaiting approval', 'Blocked', 'Applied', 'No change', 'Error'], 200000);
  await page.waitForTimeout(600);
  await shot(page, 'undo-run-d');
  log('  back link:', await page.locator('.runhead-again').first().innerText().catch(() => 'none'));
  await ctx.close();
}

if (want('incidents')) {
  log('INCIDENTS: replay two more');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await guest(page);
  for (const who of (process.env.INCIDENTS ?? 'Supabase MCP,Google Antigravity').split(',')) {
    await page.getByRole('link', { name: 'Incidents', exact: true }).click();
    await page.locator('.incident', { hasText: who }).getByRole('button', { name: 'Replay on a clone' }).click();
    await page.locator('.runhead-word').waitFor();
    log(`  ${who}: ${page.url().split('/').pop()}`);
    const s = await waitStatus(page, ['Awaiting approval', 'Blocked', 'Applied', 'No change', 'Error'], 200000);
    await page.waitForTimeout(600);
    const tag = who.split(' ')[0].toLowerCase();
    await shot(page, `incident-${tag}-top-d`);
    log('    hero:', (await page.locator('.ww-hero').innerText().catch(() => 'no panel')).replace(/\n/g, ' | '));
    log('    gate note:', await page.getByText('The gate refused this.').count());
    if (await page.locator('#blast').count()) {
      await page.locator('#blast').scrollIntoViewIfNeeded();
      await shot(page, `incident-${tag}-blast-d`);
    }
    log('    status', s);
  }
  await ctx.close();
}

if (want('gauntlet')) {
  log('GAUNTLET: one real run');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await guest(page);
  await page.getByRole('link', { name: /Attack the guardrails/ }).click();
  await page.locator('#gauntlet').waitFor();
  await page.waitForTimeout(800);
  log('  scrolled to section, y =', await page.evaluate(() => Math.round(window.scrollY)));
  await shot(page, 'gauntlet-before-d');
  await page.getByRole('button', { name: 'Attack the guardrails' }).click();
  await page.waitForTimeout(1500);
  await page.locator('#gauntlet').scrollIntoViewIfNeeded();
  await shot(page, 'gauntlet-start-d');
  let last = -1;
  const start = Date.now();
  while (Date.now() - start < 420000) {
    const rounds = await page.locator('.gt-round:not(.is-pending)').count();
    if (rounds !== last) {
      last = rounds;
      log(`  rounds finished: ${rounds}`);
      if (rounds === 2) {
        await page.locator('#gauntlet').scrollIntoViewIfNeeded();
        await shot(page, 'gauntlet-progress-d');
      }
    }
    if (!(await page.getByRole('button', { name: 'Attacking' }).count()) && Date.now() - start > 5000) break;
    await page.waitForTimeout(1500);
  }
  await page.locator('#gauntlet').scrollIntoViewIfNeeded();
  await shot(page, 'gauntlet-done-d');
  log('  summary:', (await page.locator('.gt-summary').innerText().catch(() => 'none')).replace(/\n/g, ' | '));
  for (const r of await page.locator('.gt-round').all()) log('   ', (await r.locator('.gt-round-head').innerText()).replace(/\n/g, ' '));
  const accept = page.getByRole('button', { name: 'Accept this guardrail' }).first();
  if (await accept.count()) {
    await accept.scrollIntoViewIfNeeded();
    await shot(page, 'gauntlet-candidate-d');
    await accept.click();
    await page.getByText('Accepted. It is in the frozen guardrails above.').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
    await page.getByText('Accepted. It is in the frozen guardrails above.').first().scrollIntoViewIfNeeded();
    await shot(page, 'gauntlet-accepted-d');
    log('  learned marks now:', await page.locator('.learned').count());
    await page.locator('.learned').last().scrollIntoViewIfNeeded();
    await shot(page, 'gauntlet-learned-mark-d');
  }
  await ctx.close();
}

if (want('phone')) {
  log('PHONE: the new pages at 390');
  const { ctx, page } = await open({ width: 390, height: 844 }, { mobile: true });
  await guest(page);
  const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await shot(page, 'phone-home', { full: true });
  log('  home overflow', await over());
  for (const [name, link] of [['incidents', 'Incidents'], ['receipts', 'Receipts'], ['guardrails', 'Guardrails']]) {
    await page.getByRole('link', { name: link, exact: true }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(600);
    log(`  ${name} overflow`, await over());
    await shot(page, `phone-${name}`);
    if (name === 'guardrails') {
      await page.locator('#gauntlet').scrollIntoViewIfNeeded();
      await shot(page, 'phone-gauntlet');
      await page.locator('.gt-round').first().scrollIntoViewIfNeeded().catch(() => {});
      await shot(page, 'phone-gauntlet-round');
    }
  }
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('sr.session')).tokens.judge);
  const runs = await page.evaluate(async (t) => (await fetch('/api/runs?limit=40', { headers: { Authorization: `Bearer ${t}` } })).json(), token);
  const picks = {
    multi: runs.find((r) => (r.attempts ?? 0) > 1),
    applied: runs.find((r) => r.status === 'applied' && r.source !== 'undo'),
    incident: runs.find((r) => r.source === 'incident' && r.status === 'blocked'),
    rejected: runs.find((r) => r.status === 'rejected'),
  };
  for (const [name, r] of Object.entries(picks)) {
    if (!r) continue;
    await page.goto(`${BASE}/runs/${r.id}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    log(`  run ${name} ${r.id} overflow`, await over());
    await shot(page, `phone-run-${name}`);
    if (await page.locator('#compare').count()) {
      await page.locator('#compare').scrollIntoViewIfNeeded();
      await shot(page, `phone-run-${name}-compare`);
    }
    if (await page.locator('.undo').count()) {
      await page.locator('.undo').scrollIntoViewIfNeeded();
      await shot(page, `phone-run-${name}-undo`);
    }
    if (await page.locator('#learn').count()) {
      await page.locator('#learn').scrollIntoViewIfNeeded();
      await shot(page, `phone-run-${name}-learn`);
    }
  }
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
  await page.getByRole('link', { name: 'Guardrails', exact: true }).click();
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
  // Signed out, reading is public and replaying signs you in as a guest.
  const out = await open({ width: 1440, height: 900 });
  await out.page.goto(`${BASE}/incidents`, { waitUntil: 'networkidle' });
  log('  signed out, incidents listed:', await out.page.locator('.incident').count());
  await out.page.goto(`${BASE}/receipts`, { waitUntil: 'networkidle' });
  log('  signed out, receipts listed:', await out.page.locator('.receipt').count());
  await out.page.goto(`${BASE}/incidents`, { waitUntil: 'networkidle' });
  await out.page.locator('.incident', { hasText: 'Supabase MCP' }).getByRole('button', { name: 'Replay on a clone' }).click();
  await out.page.locator('.runhead-word').waitFor({ timeout: 30000 });
  log('  signed out, replay reached run', out.page.url().split('/').pop(), 'as', await out.page.locator('.identity .seg-btn.is-on').innerText());
  await out.ctx.close();
}

if (want('look')) {
  log('LOOK: named runs at both sizes');
  for (const [name, vp, mobile] of [['d', { width: 1440, height: 900 }, false], ['m', { width: 390, height: 844 }, true]]) {
    const { ctx, page } = await open(vp, { mobile });
    await guest(page);
    for (const id of (process.env.RUNS ?? '').split(',').filter(Boolean)) {
      await page.goto(`${BASE}/runs/${id}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      log(`  ${name} ${id}: ${await page.locator('.runhead-word').innerText()}, overflow ${over}`);
      if (await page.locator('#compare').count()) {
        await page.locator('#compare').scrollIntoViewIfNeeded();
        await shot(page, `look-${id}-${name}`);
      }
    }
    await ctx.close();
  }
}

if (want('reset')) {
  log('RESET: reseeding both targets through the page');
  const { ctx, page } = await open({ width: 1440, height: 900 });
  await guest(page);
  await page.getByRole('link', { name: 'Guardrails', exact: true }).click();
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
