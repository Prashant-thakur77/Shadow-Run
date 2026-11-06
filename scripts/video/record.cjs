// Records each scene of the demo against the running app, as a real user would drive it.
// Usage: node scripts/video/record.cjs <base-url> [scene ...]. Writes var/video/scene-<id>.webm.
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const { chromium, request: apiRequest } = require(path.join(ROOT, 'web/node_modules/playwright'));
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const BASE = process.argv[2];
const ONLY = process.argv.slice(3);
const OUT = path.join(ROOT, 'var/video');
fs.mkdirSync(OUT, { recursive: true });
const scenes = JSON.parse(fs.readFileSync(path.join(OUT, 'scenes.json')));
const secs = id => scenes.find(s => s.id === id).seconds;
const W = 1600, H = 900;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TASK = 'Archive users who have been inactive for over a year. They should be removed from the users table.';
const DONE = ['awaiting_approval', 'approved', 'blocked', 'applied', 'rolled_back', 'drift_detected', 'error', 'no_change'];

async function api(_req, method, url, token, data) {
  const rq = await apiRequest.newContext();
  const r = await rq[method](BASE + url, { headers: { Authorization: 'Bearer ' + token }, data });
  const body = await r.json();
  await rq.dispose();
  return body;
}

async function withPage(id, user, fn) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: OUT, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const started = Date.now();
  let token = null;
  let trim = 0;
  if (user) {
    // The real sign-in page, with both demo passwords, so switching identity is one click.
    await page.addInitScript(() => { document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.zoom = '1.25'; }); });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Password for judge').fill(env.SHADOWRUN_JUDGE_PASSWORD);
    await page.getByLabel('Password for reviewer').fill(env.SHADOWRUN_REVIEWER_PASSWORD);
    await page.getByRole('button', { name: 'Sign in as judge' }).click();
    await page.getByRole('heading', { name: 'Give the agent a task' }).waitFor();
    token = await apiLogin('judge');
    await page.waitForTimeout(300);
    trim = (Date.now() - started) / 1000;
  }
  const t0 = Date.now();
  const skipTo = await fn(page, token, ctx);
  const video = page.video();
  await ctx.close();
  await browser.close();
  fs.renameSync(await video.path(), path.join(OUT, `scene-${id}.webm`));
  // A scene can ask to drop its setup from the front of the clip, as seconds since it began.
  const cut = trim + (typeof skipTo === 'number' ? skipTo : 0);
  fs.writeFileSync(path.join(OUT, `scene-${id}.trim`), String(cut));
  console.log(id, ((Date.now() - t0) / 1000).toFixed(1) + 's recorded, trim ' + cut.toFixed(1));
}

async function apiLogin(user) {
  const rq = await apiRequest.newContext();
  const pw = user === 'reviewer' ? env.SHADOWRUN_REVIEWER_PASSWORD : env.SHADOWRUN_JUDGE_PASSWORD;
  const r = await rq.post(BASE + '/api/login', { data: { username: user, password: pw } });
  const tok = (await r.json()).token;
  await rq.dispose();
  return tok;
}

// Puts an element near the top of the view, under the fixed header. Waits for layout to settle first.
async function goTo(page, locator, offset = -70) {
  await locator.waitFor({ timeout: 15000 });
  await page.waitForTimeout(500);
  await locator.evaluate((el, off) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + off, behavior: 'instant' }), offset);
  await page.waitForTimeout(200);
}

async function tryBreak(page, title) {
  const card = page.locator('.break', { hasText: title }).first();
  await card.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 80));
  await page.waitForTimeout(500);
  await card.getByRole('button', { name: 'Try it' }).click();
  await page.waitForTimeout(1800);
}

function card(lines, sub) {
  return `<!doctype html><html><body style="margin:0;background:#101213;color:#efece6;font-family:Inter,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="max-width:1240px;padding:0 60px">${lines}${sub ? `<div style="margin-top:44px;font-size:26px;color:#9a9a93">${sub}</div>` : ''}</div></body></html>`;
}

const stories = {
  async hook() {
    await withPage('hook', null, async page => {
      await page.setContent(card(`
        <div style="font-size:78px;font-weight:700;line-height:1.06">Production database and backups deleted in <span style="color:#ef6a5a">9 seconds</span>.</div>
        <div style="font-size:28px;margin-top:28px;color:#c9c6bf">PocketOS, April 2026: a coding agent found an API token in an unrelated file (founder's account).</div>
        <div style="font-size:28px;margin-top:14px;color:#c9c6bf">DataTalks.Club, February 2026: <code>terraform destroy</code> from a stale state file, database offline for about a day.</div>
        <div style="font-size:28px;margin-top:14px;color:#c9c6bf">SaaStr, July 2025: records wiped during a code freeze.</div>`));
      await sleep(secs('hook') * 1000 + 400);
    });
  },
  async title() {
    await withPage('title', null, async page => {
      await page.setContent(card(`<div style="font-size:112px;font-weight:700;letter-spacing:-2px">Shadow Run</div><div style="font-size:40px;margin-top:20px;color:#c9c6bf">Your agent wants to touch prod.<br>Shadow Run lets it break a clone first.</div>`));
      await sleep(secs('title') * 1000 + 400);
    });
  },
  async task() {
    await withPage('task', 'judge', async (page, token) => {
      await page.goto(BASE + '/');
      await page.waitForTimeout(800);
      await api(page.request, 'post', '/api/demo/reset', token);
      await page.reload();
      await page.waitForTimeout(1200);
      await page.getByRole('button', { name: /^Archive users/ }).click();
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'Rehearse on a clone' }).click();
      await page.waitForURL(/\/runs\//, { timeout: 30000 });
      const id = page.url().split('/runs/')[1];
      fs.writeFileSync(path.join(OUT, 'run-id.txt'), id);
      for (let i = 0; i < 200; i++) {
        const j = await api(page.request, 'get', `/api/runs/${id}`, token);
        if (DONE.includes(j.status) || (j.attempts || []).some(a => a.report)) break;
        await sleep(500);
      }
      await sleep(1200);
    });
  },
  async blast() {
    const id = fs.readFileSync(path.join(OUT, 'run-id.txt'), 'utf8').trim();
    await withPage('blast', 'judge', async (page, token) => {
      for (let i = 0; i < 240; i++) {
        const j = await api(page.request, 'get', `/api/runs/${id}`, token);
        if (DONE.includes(j.status)) break;
        await sleep(1000);
      }
      await page.goto(`${BASE}/runs/${id}`);
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: /^Attempt 1/ }).first().click();
      await page.waitForTimeout(600);
      await goTo(page, page.locator('h2', { hasText: 'Blast radius' }).first());
      await sleep(secs('blast') * 450);
      const graph = page.locator('.react-flow').first();
      if (await graph.count()) { await graph.waitFor({ timeout: 8000 }).catch(() => {}); await goTo(page, graph, -40); }
      await sleep(secs('blast') * 450);
      await goTo(page, page.locator('h2', { hasText: 'Guardrails' }).first());
      await sleep(secs('blast') * 500 + 400);
    });
  },
  async retry() {
    const id = fs.readFileSync(path.join(OUT, 'run-id.txt'), 'utf8').trim();
    await withPage('retry', 'judge', async page => {
      await page.goto(`${BASE}/runs/${id}`);
      await page.waitForTimeout(1200);
      await goTo(page, page.locator('h2', { hasText: 'Attempts' }).first());
      await sleep(secs('retry') * 500);
      await goTo(page, page.locator('h2', { hasText: 'Guardrails' }).first());
      await sleep(secs('retry') * 500 + 400);
    });
  },
  async redteam() {
    await withPage('redteam', 'judge', async page => {
      await page.goto(BASE + '/redteam');
      await page.waitForTimeout(1200);
      await page.getByRole('button', { name: /Run the red team/ }).click();
      const started = Date.now();
      for (;;) {
        await sleep(1200);
        const r = await page.evaluate(async () => (await (await fetch('/api/redteam?limit=1', { credentials: 'include' })).json())[0]?.status);
        if ((r && r !== 'running') || Date.now() - started > 150000) break;
        const n = await page.evaluate(() => document.body.scrollHeight);
        await page.evaluate(([h, t]) => window.scrollTo({ top: ((t % 30000) / 30000) * h * 0.75, behavior: 'smooth' }), [n, Date.now() - started]);
      }
      await sleep(1200);
      await goTo(page, page.getByText(/Prod untouched/).locator('visible=true').first(), -120);
      await sleep(7000);
    });
  },
  async approve() {
    const id = fs.readFileSync(path.join(OUT, 'run-id.txt'), 'utf8').trim();
    await withPage('approve', 'judge', async page => {
      await page.goto(`${BASE}/runs/${id}`);
      await page.waitForTimeout(1200);
      await tryBreak(page, 'Approve your own run');
      await tryBreak(page, 'Approve with a tampered plan hash');
      await sleep(1000);
      await page.getByRole('button', { name: 'Switch to reviewer' }).first().click();
      await page.waitForTimeout(600);
      const pw = page.locator('input[type=password]').first();
      if (await pw.count()) { await pw.fill(env.SHADOWRUN_REVIEWER_PASSWORD); await page.keyboard.press('Enter'); }
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await approve.waitFor({ timeout: 15000 });
      await approve.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1500);
      await approve.click();
      const go = page.getByRole('button', { name: 'Apply to prod' });
      await go.waitFor({ timeout: 15000 });
      await page.waitForTimeout(800);
      await go.click();
      const done = page.getByText('Committed', { exact: true }).locator('visible=true').first();
      await done.waitFor({ timeout: 60000 });
      await done.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 120));
      await sleep(3500);
    });
  },
  async drift() {
    await withPage('drift', 'judge', async (page, token) => {
      const begun = Date.now();
      await api(page.request, 'post', '/api/demo/reset', token);
      const made = await api(page.request, 'post', '/api/runs', token, { steps: [{ type: 'sql', cmd: "UPDATE users SET status = 'suspended' WHERE last_login_at < now() - interval '2 years'", why: 'Suspend long-inactive users' }] });
      let run;
      for (let i = 0; i < 120; i++) {
        run = await api(page.request, 'get', `/api/runs/${made.id}`, token);
        if (DONE.includes(run.status)) break;
        await sleep(800);
      }
      const c = run.challenge;
      await api(page.request, 'post', `/api/runs/${made.id}/approve`, await apiLogin('reviewer'), { plan_hash: c.plan_hash, guardrails_hash: c.guardrails_hash, report_hash: c.report_hash, nonce: c.nonce });
      await page.goto(`${BASE}/runs/${made.id}`);
      await page.waitForTimeout(1500);
      const skip = (Date.now() - begun) / 1000 - 1;
      await tryBreak(page, 'Change prod behind its back');
      await sleep(600);
      await tryBreak(page, 'Now apply, drift check off');
      const rolled = page.getByText('Rolled back', { exact: true }).locator('visible=true').first();
      await rolled.waitFor({ timeout: 60000 });
      await rolled.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 60));
      await sleep(5000);
      return skip;
    });
  },
  async mcp() {
    const src = fs.readFileSync(path.join(ROOT, 'docs/evidence/opencode-session.md'), 'utf8');
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const body = src.split('\n').slice(4).filter(l => l.trim() && !l.startsWith('```')).map(l => {
      if (l.startsWith('**Tool')) return `<div style="color:#7fd1b9;margin-top:18px">${esc(l.replace(/\*\*/g, '').replace(/`/g, ''))}</div>`;
      if (l.startsWith('> ')) return `<div style="color:#efece6;margin-top:14px">${esc(l.slice(2))}</div>`;
      if (l.startsWith('- measured')) return `<div style="color:#ef6a5a">${esc(l)}</div>`;
      if (l.startsWith('Result')) return `<div style="color:#e8c34a">${esc(l)}</div>`;
      return `<div style="color:#9a9a93">${esc(l)}</div>`;
    }).join('');
    await withPage('mcp', null, async page => {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#0b0c0d;color:#efece6;font:21px/1.5 ui-monospace,Menlo,Consolas,monospace"><div style="position:fixed;top:0;left:0;right:0;background:#1c1e20;padding:12px 26px;color:#c9c6bf">opencode run, model vultr/qwen3.8-27b, MCP server: shadowrun. Recorded session, from docs/evidence/opencode-session.md</div><div id="s" style="padding:70px 34px 60px">${body}</div></body></html>`);
      const total = secs('mcp') * 1000;
      const h = await page.evaluate(() => document.body.scrollHeight - window.innerHeight);
      const t0 = Date.now();
      while (Date.now() - t0 < total) { await page.evaluate(y => window.scrollTo(0, y), h * (Date.now() - t0) / total); await sleep(50); }
      await sleep(600);
    });
  },
  async results() {
    await withPage('results', 'judge', async page => {
      await page.goto(BASE + '/results');
      await page.waitForTimeout(1200);
      await sleep(secs('results') * 1000 + 400);
    });
  },
  async close() {
    const svg = fs.readFileSync(path.join(ROOT, 'docs/architecture.svg'), 'utf8');
    await withPage('close', null, async page => {
      await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;height:100vh"><div style="width:1500px">${svg}</div></body></html>`);
      await sleep(secs('close') * 1000 + 400);
    });
  },
};

(async () => {
  const ids = ONLY.length ? ONLY : Object.keys(stories);
  for (const id of ids) await stories[id]();
})().catch(e => { console.error(e); process.exit(1); });
