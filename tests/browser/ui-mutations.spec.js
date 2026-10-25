// UI-click regression proof for the two consolidation fixes (2026-10-25):
//  1. Frontend CSRF adoption: api.js now adopts csrfToken from auth responses
//     AND GET /api/auth/csrf returns the session's stored token when called
//     authenticated (previously it minted a fresh random token on every call,
//     so every authenticated UI mutation 403'd with CSRF_INVALID — both on
//     fresh login AND after any reload).
//  2. CSP styling: the inline <style> block moved to /src/styles.css and all
//     inline style=/onerror attributes became classes / a delegated listener,
//     so the style-src 'self' policy no longer blocks the app's own styling.
// These tests use ONLY UI clicks for mutations — no browser-fetch workaround.
// If either fix regresses, these tests fail (the older specs keep passing via
// their fetch workarounds, so they cannot catch a UI regression).
// The openConv rendering scenario lives in chat.spec.js (converted from its
// known-issue test), not duplicated here.
import { test, expect } from '@playwright/test';
import { registerViaUI, anonViaUI, goTab, collectProblems, uniq, baseUrl } from './helpers.mjs';

test('UI: register, create room via UI, send via UI click, message renders', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const problems = collectProblems(page);
  try {
    await registerViaUI(page, uniq('UIClick'));
    // Create a public room through the UI form.
    await goTab(page, 'Chats');
    await page.getByRole('button', { name: '+ New' }).click();
    const roomName = uniq('UIRoom');
    await page.locator('#cf-name').fill(roomName);
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('#in')).toBeVisible();
    // Send through the UI Send button (not fetch).
    const text = uniq('hello-ui');
    await page.locator('#in').fill(text);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('#ml')).toContainText(text);
    // No CSRF failure toast, no JS errors, no failed requests, no CSP errors.
    await expect(page.locator('#t')).toBeHidden();
    problems.assertClean('ui-mutations');
    expect(problems.csp, 'no CSP console errors after the stylesheet fix').toEqual([]);
  } finally { await ctx.close(); }
});

test('UI: claim rotates the session and later UI mutations still work', async ({ browser }) => {
  // Regression test for the security track's follow-up #1: after claim(),
  // the server revokes the old session and issues a fresh one with a new
  // csrfToken. The frontend must adopt it (api.js does this for every auth
  // response) or the next UI mutation 403s. Covers: anonymous via UI →
  // claim via UI → create room via UI with the rotated session.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await anonViaUI(page);
    await goTab(page, 'Profile');
    const email = `${uniq('claim')}@nexora.local`;
    await page.locator('#cl-e').fill(email);
    await page.locator('#cl-p').fill('Password123!x');
    await page.getByRole('button', { name: 'Claim account' }).click();
    await expect(page.locator('#t')).toContainText('Account claimed');
    await goTab(page, 'Chats');
    await page.getByRole('button', { name: '+ New' }).click();
    await page.locator('#cf-name').fill(uniq('ClaimRoom'));
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('#in')).toBeVisible();
  } finally { await ctx.close(); }
});

test('UI: stylesheet loads under CSP (computed styles are the theme, not browser defaults)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const problems = collectProblems(page);
  try {
    await page.goto(`${baseUrl()}/`, { waitUntil: 'networkidle' });
    const styles = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return { background: cs.backgroundColor, font: cs.fontFamily };
    });
    // Before the fix the inline <style> was blocked: transparent background
    // and the browser default serif font. Either theme color proves the
    // external stylesheet applied.
    expect(styles.background, `body background must be a theme color, got ${styles.background}`).not.toBe('rgba(0, 0, 0, 0)');
    expect(styles.font, `font must be the system stack, got ${styles.font}`).toMatch(/system-ui/);
    expect(problems.csp, 'no CSP console errors on an ordinary page').toEqual([]);
  } finally { await ctx.close(); }
});
