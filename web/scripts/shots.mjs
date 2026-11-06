// Visual check. Usage: node scripts/shots.mjs [filter] [--theme=light] [--vp=d|m]
// Fixture pages only need the dev server. Screenshots go to .shots/, which git ignores.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const BASE = process.env.SHOTS_BASE ?? 'http://127.0.0.1:5173';
const OUT = fileURLToPath(new URL('../.shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const filter = args.find((a) => !a.startsWith('--'));
const theme = args.find((a) => a.startsWith('--theme='))?.split('=')[1];
const only = args.find((a) => a.startsWith('--vp='))?.split('=')[1];
const SEG = Number(args.find((a) => a.startsWith('--seg='))?.split('=')[1] ?? 1300);

const PAGES = [
  ['signin', '/?fixture=signin'],
  ['landing-headline', '/?fixture=landing-headline&signedout=1'],
  ['run-trap', '/runs/x?fixture=run-trap'],
  ['run-incident-saastr', '/runs/x?fixture=run-incident-saastr'],
  ['run-incident-home', '/runs/x?fixture=run-incident-home'],
  ['run-warnings', '/runs/x?fixture=run-warnings'],
  ['incidents', '/incidents?fixture=incidents'],
  ['receipts', '/receipts?fixture=receipts'],
  ['receipts-empty', '/receipts?fixture=receipts-empty'],
  ['gauntlet', '/guardrails?fixture=gauntlet#gauntlet'],
  ['gauntlet-running', '/guardrails?fixture=gauntlet-running#gauntlet'],
  ['gauntlet-held', '/guardrails?fixture=gauntlet-held#gauntlet'],
  ['home', '/?fixture=home'],
  ['run-retry-requester', '/runs/x?fixture=run-agent-retry'],
  ['run-blocked-cascade', '/runs/x?fixture=run-blocked-cascade'],
  ['run-diff', '/runs/x?fixture=run-blocked-cascade', 'diff'],
  ['run-blocked-gate', '/runs/x?fixture=run-blocked-by-gate'],
  ['run-awaiting-reviewer', '/runs/x?fixture=run-awaiting-approval-as-reviewer'],
  ['run-awaiting-requester', '/runs/x?fixture=run-awaiting-approval-as-requester'],
  ['run-approved', '/runs/x?fixture=run-approved'],
  ['run-applied', '/runs/x?fixture=run-applied'],
  ['run-auto-applied', '/runs/x?fixture=run-auto-applied'],
  ['run-drift', '/runs/x?fixture=run-drift-detected'],
  ['run-rolled-back', '/runs/x?fixture=run-rolled-back'],
  ['run-live-planning', '/runs/x?fixture=run-agent-retry&cut=3'],
  ['run-live-rehearsing', '/runs/x?fixture=run-agent-retry&cut=6'],
  ['run-live-attempt2', '/runs/x?fixture=run-agent-retry&cut=12'],
  ['run-host-blocked', '/runs/x?fixture=run-host-blocked'],
  ['run-host-awaiting', '/runs/x?fixture=run-host-awaiting'],
  ['run-host-applied', '/runs/x?fixture=run-host-applied'],
  ['run-host-drift', '/runs/x?fixture=run-host-drift'],
  ['run-host-nochange', '/runs/x?fixture=run-host-nochange'],
  ['run-minimal', '/runs/x?fixture=run-minimal'],
  ['run-error', '/runs/x?fixture=run-error'],
  ['run-hostile', '/runs/x?fixture=run-hostile'],
  ['redteam', '/redteam?fixture=redteam'],
  ['redteam-partial', '/redteam?fixture=redteam-partial&n=3'],
  ['redteam-failed', '/redteam?fixture=redteam-failed'],
  ['redteam-none', '/redteam?fixture=redteam-none'],
  ['target', '/guardrails?fixture=target'],
  ['results', '/results?fixture=results'],
  ['results-table', '/results?fixture=results-table'],
  ['audit', '/audit?fixture=audit'],
];

const VIEWPORTS = [
  ['d', { width: 1440, height: 900 }, 1],
  ['m', { width: 390, height: 844 }, 2],
  // The video is recorded at 125% browser zoom on a 1440x900 screen.
  ['z', { width: 1152, height: 720 }, 1.25],
];

const browser = await chromium.launch();
let problems = 0;
for (const [vpName, viewport, scale] of VIEWPORTS) {
  if (only ? only !== vpName : vpName === 'z') continue;
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, isMobile: vpName === 'm', hasTouch: vpName === 'm' });
  if (theme) await ctx.addInitScript((t) => localStorage.setItem('sr.theme', t), theme);
  for (const [name, path, action] of PAGES) {
    if (filter && !name.includes(filter)) continue;
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('401')) errors.push(`console: ${m.text().slice(0, 300)}`);
    });
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(500);
    if (action === 'diff') {
      await page.getByText(/^Sample rows, before and after/).click();
      for (const t of ['users', 'payments']) await page.locator('.sample-tables summary', { hasText: t }).first().click();
      await page.locator('.sample').first().waitFor();
      await page.waitForTimeout(600);
    }
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const offenders = [];
      if (document.documentElement.scrollWidth > w) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.right > w + 1 && r.width > 0) {
            let p = el.parentElement;
            let scroller = false;
            while (p) {
              const o = getComputedStyle(p).overflowX;
              if (o === 'auto' || o === 'scroll' || o === 'hidden') scroller = true;
              p = p.parentElement;
            }
            if (!scroller) offenders.push(`${el.tagName}.${el.className}`.slice(0, 80));
          }
        }
      }
      return { scroll: document.documentElement.scrollWidth, width: w, offenders: offenders.slice(0, 6) };
    });
    const pwned = await page.evaluate(() => document.body.dataset.pwned ?? null);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const tag = `${name}-${vpName}${theme ? `-${theme}` : ''}`;
    if (height <= SEG * 1.3) {
      await page.screenshot({ path: `${OUT}${tag}.png`, fullPage: true });
    } else {
      let i = 0;
      for (let y = 0; y < height; y += SEG) {
        i += 1;
        await page.screenshot({ path: `${OUT}${tag}-p${i}.png`, fullPage: true, clip: { x: 0, y, width: viewport.width, height: Math.min(SEG, height - y) } });
      }
    }
    const bad = overflow.scroll > overflow.width || errors.length || pwned;
    if (bad) problems += 1;
    console.log(`${bad ? 'PROBLEM' : 'ok     '} ${tag} h=${height} scrollW=${overflow.scroll}/${overflow.width}${overflow.offenders.length ? ` offenders=${overflow.offenders.join(' | ')}` : ''}${pwned ? ' PWNED' : ''}`);
    for (const e of errors) console.log(`   ${e}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(problems ? `${problems} pages with problems` : 'no problems');
