// Screenshots for the README, taken from a real run on the running app. Usage: node scripts/video/readme_shots.cjs <base-url>
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const { chromium } = require(path.join(ROOT, 'web/node_modules/playwright'));
const BASE = process.argv[2];
const OUT = path.join(ROOT, 'docs/img');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: 'Continue as guest' }).click();
  await page.getByRole('heading', { name: 'Give the agent a task' }).waitFor({ timeout: 15000 });
  const token = await page.evaluate(() => fetch('/api/me', { credentials: 'include' }).then(r => r.json()));
  if (!token) throw new Error('not signed in');
  // The trap plan, fixed, so the shot shows the same thing every time.
  const made = await page.evaluate(async () => {
    await fetch('/api/demo/reset', { method: 'POST', credentials: 'include' });
    const r = await fetch('/api/runs', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps: [{ type: 'sql', cmd: "DELETE FROM users WHERE last_login_at < now() - interval '1 year'" }], source: 'api' }) });
    return r.json();
  });
  for (let i = 0; i < 120; i++) {
    const run = await page.evaluate(id => fetch('/api/runs/' + id, { credentials: 'include' }).then(r => r.json()), made.id);
    if (['blocked', 'awaiting_approval', 'error'].includes(run.status)) break;
    await page.waitForTimeout(1000);
  }
  await page.goto(`${BASE}/runs/${made.id}`);
  await page.waitForTimeout(1500);
  const panel = page.locator('section', { has: page.locator('h2', { hasText: 'Without and with' }) }).first();
  await panel.waitFor({ timeout: 15000 });
  await panel.screenshot({ path: path.join(OUT, 'with-without.png') });
  console.log('wrote docs/img/with-without.png');
  await browser.close();
})().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });
