// The lablab cover, 1920x1080: the live site's own hero at the end of its replay, with the page chrome hidden.
// Nothing is drawn here, so every figure on it is what the site shows. Run it after a deploy, so it shows the published numbers.
//   node scripts/make_cover.cjs <web dir> <url> <out.png>
const { chromium } = require(require("path").resolve(process.argv[2], "node_modules/playwright"));
(async () => {
  const [url, out] = [process.argv[3], process.argv[4]];
  const b = await chromium.launch();
  // 1600x900 is the layout the hero is designed at; 1.2x makes it 1920x1080.
  const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2, colorScheme: 'dark', reducedMotion: 'reduce' });
  await p.goto(url, { waitUntil: 'networkidle' });
  await p.addStyleTag({
    content: `.land-nav,.skip-link,.hero-caption,.hero-bar-side,.xr{display:none!important}
      .hero-bar{justify-content:flex-start!important}
      body{padding-top:120px!important}`,
  });
  // Reduced motion shows the replay's end state at once; wait for the measured numbers to be in.
  await p.waitForFunction(() => /PROD/.test(document.body.innerText) && /\$[\d,]+\.\d\d/.test(document.body.innerText), null, { timeout: 30000 });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(1500);
  const top = await p.evaluate(() => {
    const t = document.querySelector('.hero-title').getBoundingClientRect().top;
    const bar = document.querySelector('.hero-bar');
    const end = (bar || document.querySelector('.hero-stage')).getBoundingClientRect().bottom;
    return { t, end };
  });
  // Centre the hero in the frame.
  const pad = Math.max(0, (900 - (top.end - top.t)) / 2);
  const y = top.t - pad + (await p.evaluate(() => scrollY));
  await p.screenshot({ path: out, fullPage: true, clip: { x: 0, y: Math.max(0, y), width: 1600, height: 900 } });
  console.log('cover', out, JSON.stringify(top));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
