import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const OUT = 'Z:/328/CMPUT328-A2/codexworks/301/harmonizer-android/_design/shots/';
mkdirSync(OUT, { recursive: true });

const targets = [
  ['index', 'https://harmonizerlabs.cc/'],
  ['lab',   'https://harmonizerlabs.cc/harmonizer.html'],
];
const viewports = [
  ['mobile', 390, 844],
  ['desktop', 1440, 900],
];

const browser = await chromium.launch();
for (const [name, url] of targets) {
  for (const [vp, w, h] of viewports) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    } catch (e) {
      console.log(`${name}/${vp} goto warn: ${e.message}`);
    }
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}${name}-${vp}-top.png` });
    await page.screenshot({ path: `${OUT}${name}-${vp}-full.png`, fullPage: true });
    console.log(`captured ${name}/${vp}`);
    await ctx.close();
  }
}
await browser.close();
console.log('done');
