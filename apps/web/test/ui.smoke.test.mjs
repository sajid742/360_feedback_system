/**
 * UI smoke test (Playwright). Requires the web dev/preview server + API running.
 * Run: `npm run -w apps/web test:ui`  (uses WEB_BASE, default http://localhost:5173)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const WEB = process.env.WEB_BASE ?? 'http://localhost:5173';
const EMAIL = process.env.TEST_ADMIN_EMAIL ?? 'sajidq@carepvtltd.com';
const PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? 'Password123!';

test('login and core screens render without crashing', async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="password"]', { timeout: 20000 });
    await page.waitForSelector('input[type="email"]', { timeout: 20000 });
    await page.waitForTimeout(300);
    const slug = await page.$('input[type="text"]'); // org slug is pre-filled by default
    if (slug) await slug.fill('care');
    await (await page.$('input[type="email"]')).fill(EMAIL);
    await (await page.$('input[type="password"]')).fill(PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(3500);
    assert.ok(!page.url().endsWith('/login'), 'login navigated away from /login');
    // '/org-chart' is included because the chart moved off the Organization page onto
    // its own route; this is the cheapest way to catch a broken lazy import.
    for (const route of ['/', '/organization', '/org-chart', '/appraisal', '/reports', '/access-control']) {
      await page.goto(`${WEB}${route}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      const body = (await page.textContent('body')) || '';
      assert.ok(body.trim().length > 50, `route ${route} rendered content`);
      assert.ok(!/Something went wrong|Unexpected Application Error/i.test(body), `route ${route} no error boundary`);
    }
    // The chart is its own page now: reachable from the sidebar, and gone from the
    // Organization tab strip.
    await page.goto(`${WEB}/org-chart`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const chartBody = (await page.textContent('body')) || '';
    assert.ok(/Org Chart/.test(chartBody), 'the Org Chart page renders its heading');
    assert.ok(/Units/.test(chartBody) && /People/.test(chartBody), 'both chart views are offered');

    await page.goto(`${WEB}/organization`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const tabs = await page.$$eval('[role="tab"]', (els) => els.map((e) => e.textContent?.trim()));
    assert.ok(!tabs.includes('Org Chart'), `Organization no longer has an Org Chart tab (saw: ${tabs.join(', ')})`);

    assert.equal(pageErrors.length, 0, 'no uncaught page errors: ' + pageErrors.join('; '));
  } finally {
    await browser.close();
  }
});
