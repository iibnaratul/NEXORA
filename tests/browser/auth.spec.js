// (B) Auth / sessions in a REAL Chromium browser:
// anonymous identity (server-issued NXR ID shown in the Profile UI),
// register + login + logout through the UI, reload keeps a valid session,
// revocation (logout via API, then reload) denies protected UI/API,
// expiry (session row expired directly in the test DB) denies protected
// UI/API, and CSRF rejection without a valid token.
// NOTE on expiry: the app has no UI affordance to expire a session, so the
// expiry itself is applied by updating the test database's session row —
// the denial afterwards is observed entirely through the browser.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import { api, apiNoCsrf, apiMe, anonViaUI, registerViaUI, goTab, uniq, dbMode, baseUrl } from './helpers.mjs';

const REAL_URL = 'postgresql://nexora:nexora-dev-only@127.0.0.1:5432/nexora_browser';

test('auth: anonymous identity is server-issued and shown in the Profile UI', async ({ page }) => {
  const me = await anonViaUI(page);
  expect(me.nexoraId).toMatch(/^NXR-[A-Z0-9-]+$/);
  await goTab(page, 'Profile');
  await expect(page.locator('main')).toContainText(me.nexoraId);
  await expect(page.locator('main')).toContainText('ANONYMOUS');
});

test('auth: register, reload keeps session (reads only)', async ({ page }) => {
  const display = uniq('AuthUser');
  const me = await registerViaUI(page, display);
  expect(me.displayName).toBe(display);
  // Reload keeps the session (HttpOnly cookie, not localStorage identity).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  const stillMe = await apiMe(page);
  expect(stillMe.id).toBe(me.id);
});

test('auth: login via UI after a fresh boot (logout via API for setup)', async ({ page }) => {
  const me = await registerViaUI(page, uniq('LoginUser'));
  // Log out through the API for setup, then sign back in through the UI on
  // a fresh boot. (UI logout itself is covered by the fixed-behavior test.)
  const out = await api(page, 'POST', '/api/auth/logout', {});
  expect(out.status).toBe(200);
  await page.goto(`${baseUrl()}/`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Continue anonymously' })).toBeVisible();
  const card = page.locator('.c', { hasText: 'Sign in' });
  await card.getByLabel('Email').fill(me.email);
  await card.getByLabel('Password').fill('Password123!x');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  const back = await apiMe(page);
  expect(back.id).toBe(me.id);
});

test('auth: UI mutations work after the CSRF fix (logout really logs out, UI room creation works, boot token is the session token)', async ({ page }) => {
  // Regression test for the 2026-10-25 consolidation fixes: api.js adopts
  // csrfToken from auth responses, and GET /api/auth/csrf returns the
  // session's stored token when called authenticated (it previously minted
  // a fresh random token on every call, so every authenticated UI mutation
  // 403'd with CSRF_INVALID, including after any reload).
  const me = await registerViaUI(page, uniq('CsrfFixed'));
  // UI logout now really revokes the session (previously the auth view
  // appeared while the session stayed alive).
  await goTab(page, 'Profile');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue anonymously' })).toBeVisible();
  const dead = await api(page, 'GET', '/api/auth/me');
  expect(dead.status).toBe(401);
  // Fresh user: UI conversation creation now succeeds and the form closes.
  await registerViaUI(page, uniq('CsrfFixed2'));
  const roomName = uniq('ShouldExist');
  await page.getByRole('button', { name: '+ New' }).click();
  await page.locator('#cf-type').selectOption('room');
  await page.locator('#cf-name').fill(roomName);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('#in')).toBeVisible();
  const convs = await api(page, 'GET', '/api/conversations?limit=100');
  expect(convs.json.data.find((c) => c.name === roomName)).toBeDefined();
  // The boot token is now the session token: a mutation sent with it (exactly
  // what the frontend sends after a reload) succeeds.
  const bootTokenLogout = await page.evaluate(async () => {
    const csrfRes = await fetch('/api/auth/csrf', { credentials: 'include' });
    const csrfJson = await csrfRes.json();
    const res = await fetch('/api/auth/logout', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfJson.data.csrfToken },
      body: JSON.stringify({}),
    });
    return { status: res.status, text: await res.text() };
  });
  expect(bootTokenLogout.status).toBe(200);
});

test('auth: revocation via API — reload after logout denies protected UI/API', async ({ page }) => {
  await registerViaUI(page, uniq('RevokeUser'));
  const before = await apiMe(page);
  expect(before.id).toBeTruthy();
  // Revoke this session via the API (the logout endpoint revokes server-side).
  const logout = await api(page, 'POST', '/api/auth/logout', {});
  expect(logout.status).toBe(200);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue anonymously' })).toBeVisible();
  const denied = await api(page, 'GET', '/api/auth/me');
  expect(denied.status).toBe(401);
  const convDenied = await api(page, 'GET', '/api/conversations?limit=5');
  expect(convDenied.status).toBe(401);
});

test('auth: expired session denies protected UI/API after reload', async ({ page }) => {
  test.skip(dbMode() === 'pg-mem-fallback',
    'expiry test needs the real-PostgreSQL session table');
  const me = await registerViaUI(page, uniq('ExpiryUser'));
  // Expire every session row for this user directly in the test DB.
  const pool = new pg.Pool({ connectionString: REAL_URL });
  try {
    const r = await pool.query(
      'UPDATE user_sessions SET expires_at = now() - interval \'1 hour\' WHERE user_id = $1',
      [me.id],
    );
    expect(r.rowCount).toBeGreaterThan(0);
  } finally { await pool.end(); }
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue anonymously' })).toBeVisible();
  const denied = await api(page, 'GET', '/api/auth/me');
  expect(denied.status).toBe(401);
});

test('auth: CSRF — state-changing request without a valid token is rejected', async ({ page }) => {
  await registerViaUI(page, uniq('CsrfUser'));
  // No token at all.
  const noToken = await apiNoCsrf(page, 'POST', '/api/auth/logout', {});
  expect(noToken.status).toBe(403);
  expect(noToken.json?.error?.code).toMatch(/CSRF/);
  // A bogus token is also rejected, and the session must survive both.
  const bogus = await page.evaluate(async () => {
    const res = await fetch('/api/auth/logout', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'bogus-token-value' },
      body: JSON.stringify({}),
    });
    return { status: res.status, text: await res.text() };
  });
  expect(bogus.status).toBe(403);
  const still = await apiMe(page);
  expect(still.id).toBeTruthy();
  // The real token (from the cookie, as the frontend sends it) succeeds.
  const ok = await api(page, 'POST', '/api/auth/logout', {});
  expect(ok.status).toBe(200);
});
