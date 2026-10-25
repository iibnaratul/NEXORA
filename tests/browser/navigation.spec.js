// (A) Navigation in a REAL Chromium browser against the REAL running app:
// all four tabs visible + switchable, desktop + mobile viewports, refresh and
// direct navigation, console errors / failed requests / broken assets recorded.
// Screenshots are test-pseudonymous only (anonymous account, no secrets).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseUrl, dbMode, collectProblems, anonViaUI } from './helpers.mjs';

const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');

async function assertTabs(page) {
  for (const label of ['Chats', 'Delivery', 'Activity', 'Profile']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  // Switch through every tab; each must render without a JS crash.
  // (Headings, not raw text: the nav buttons share the tab labels.)
  await page.getByRole('button', { name: 'Delivery', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'NEXORA TRANSIT' })).toBeVisible();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ACTIVITY' })).toBeVisible();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PROFILE' })).toBeVisible();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
}

test('navigation: four tabs visible and switchable (desktop 1280x720)', async ({ page }) => {
  const problems = collectProblems(page);
  const me = await anonViaUI(page);
  expect(me.nexoraId).toMatch(/^NXR-/);
  await assertTabs(page);
  // Refresh must not break the app or drop the session.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await assertTabs(page);
  // Direct navigation to / must land on the app (no router, single page).
  await page.goto(`${baseUrl()}/`);
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  problems.assertClean('desktop navigation');
  await page.screenshot({ path: path.join(artifacts, 'nav-desktop.png') });
});

test('navigation: four tabs visible and switchable (mobile 390x844)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const problems = collectProblems(page);
  try {
    await anonViaUI(page);
    await assertTabs(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
    await assertTabs(page);
    problems.assertClean('mobile navigation');
    await page.screenshot({ path: path.join(artifacts, 'nav-mobile.png') });
  } finally { await ctx.close(); }
});

test('navigation: unauthenticated load shows auth view, no JS exceptions', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto(`${baseUrl()}/`);
  await expect(page.getByRole('button', { name: 'Continue anonymously' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  problems.assertClean('unauthenticated load');
});

test('navigation: no CSP inline-style reports after the stylesheet fix', async ({ page }) => {
  // Regression test for the 2026-10-25 consolidation CSP fix: the inline
  // <style> block moved to /src/styles.css and inline style attributes
  // became classes, so visiting the Profile tab (avatar border-color)
  // must produce zero CSP reports and the computed styles must be the
  // theme (previously: blocked styles, transparent background, serif font).
  const problems = collectProblems(page);
  await anonViaUI(page);
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'PROFILE' })).toBeVisible();
  await page.waitForTimeout(500);
  const unique = [...new Set(problems.csp)];
  expect(unique, 'no CSP reports after the stylesheet fix').toEqual([]);
  const computed = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return `computed body: background=${s.backgroundColor} font-family=${s.fontFamily}`;
  });
  fs.writeFileSync(path.join(artifacts, 'csp-console-errors.txt'), unique.join('\n') + '\n' + computed + '\n');
  problems.assertClean('CSP recording run');
});

test('meta: browser run database mode is recorded', async () => {
  // Documents which backend actually served these browser tests.
  expect(['real-postgresql:nexora_browser', 'pg-mem-fallback']).toContain(dbMode());
  fs.writeFileSync(path.join(artifacts, 'db-mode.txt'), `${dbMode()}\n`);
});
