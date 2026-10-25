// Shared helpers for browser specs. All API calls here run INSIDE the page
// (page.evaluate + fetch), so they carry the browser's own HttpOnly session
// cookie and CSRF cookie exactly like the real frontend does. Nothing here
// logs cookies, tokens, codes or passwords — only HTTP statuses are kept.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

const dir = path.dirname(fileURLToPath(import.meta.url));

export function serverInfo() {
  const info = JSON.parse(fs.readFileSync(path.join(dir, '.server.json'), 'utf8'));
  if (!info.baseUrl) throw new Error('.server.json has no baseUrl — did global setup run?');
  return info;
}
export function baseUrl() { return serverInfo().baseUrl; }
export function dbMode() { return serverInfo().dbMode; }

let n = 0;
export function uniq(tag) {
  // Kept short on purpose: the UI caps display names at 24 characters.
  n += 1;
  return `${tag}-${Date.now().toString(36)}${n}`;
}

// 1x1 PNG bytes (same minimal PNG as backend/tests/helpers.js pngBytes()).
export function pngBytes() {
  return Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
}

// Collect console errors, page errors and failed requests for a page.
// Two buckets are kept apart on purpose:
//  - `errors` / `failed`: genuine problems (JS exceptions, failed assets,
//    unexpected API failures). assertClean() fails on these.
//  - `csp`: Content-Security-Policy console reports. Before the 2026-10-25
//    consolidation fix, the frontend's inline <style> block and style=
//    attributes were blocked by helmet's `style-src 'self'` and logged
//    here. Since the fix (external stylesheet + classes), ordinary pages
//    must produce zero CSP reports; specs that care assert on `csp`
//    explicitly, and the navigation spec records the artifact.
//  - Expected by design and ignored in `failed`: the anonymous boot probe
//    GET /api/auth/me returns 401 when no session exists; the frontend
//    handles that as "show the auth view".
export function collectProblems(page) {
  const errors = [];
  const failed = [];
  const csp = [];
  const onConsole = (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // "Failed to load resource" is the browser echoing a non-2xx fetch; the
    // response listener below is the authoritative record (it has URLs),
    // so console echoes are dropped to avoid double-counting.
    if (text.startsWith('Failed to load resource')) return;
    if (text.includes('Content Security Policy')) csp.push(text);
    else errors.push(text);
  };
  const onPageError = (err) => errors.push(`pageerror: ${err.message}`);
  const onFailed = (req) => failed.push(`${req.url()} :: ${req.failure()?.errorText || 'failed'}`);
  const onResponse = (res) => {
    if (res.status() < 400 || res.url().includes('favicon')) return;
    // By-design probes the frontend itself makes and handles:
    //  - 401 /api/auth/me: anonymous boot probe ("show the auth view")
    //  - 403 /api/deliveries?view=queue: non-courier queue probe, caught
    //    by loadOrders() which falls back to an empty queue
    if (res.status() === 401 && res.url().endsWith('/api/auth/me')) return;
    if (res.status() === 403 && res.url().includes('/api/deliveries?view=queue')) return;
    failed.push(`${res.status()} ${res.url()}`);
  };
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);
  return {
    errors, failed, csp,
    assertClean(label = 'page') {
      // The app legitimately returns 4xx for negative-case API calls made
      // from page.evaluate in some specs; those specs filter `failed`
      // themselves instead of calling assertClean after negatives.
      expect(errors, `${label} console/page errors`).toEqual([]);
      expect(failed, `${label} failed requests`).toEqual([]);
    },
  };
}

// Session CSRF tokens, remembered per page by the TEST process (never
// logged). Retained from before the 2026-10-25 consolidation fix, when
// GET /api/auth/csrf minted a fresh token on every call: tests captured
// the session token once (right after login/register) and reused it for
// browser-API calls. Since the fix, /api/auth/csrf returns the session's
// stored token when authenticated, so the cookie holds the right token
// after reloads too; the remembered-token logic is now redundant but
// harmless, and keeps these helpers independent of that behavior.
const csrfTokens = new WeakMap();
export async function captureCsrf(page) {
  const token = await page.evaluate(() => {
    const raw = (document.cookie.split('; ').find((c) => c.startsWith('nx_csrf=')) || '').split('=')[1] || '';
    return raw ? decodeURIComponent(raw) : '';
  });
  if (token) csrfTokens.set(page, token);
  return token;
}

// Call the API from inside the page: session cookie is sent automatically,
// CSRF token is the remembered session token (falling back to the cookie
// when no token was captured yet).
export async function api(page, method, pathName, body) {
  const stored = csrfTokens.get(page) || '';
  const result = await page.evaluate(async ({ method, pathName, body, stored }) => {
    const cookieRaw = (document.cookie.split('; ').find((c) => c.startsWith('nx_csrf=')) || '').split('=')[1] || '';
    const csrf = stored || (cookieRaw ? decodeURIComponent(cookieRaw) : '');
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(pathName, {
      method, credentials: 'include', headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  }, { method, pathName, body, stored });
  // Adopt a fresh session token when the server issues one (login,
  // register, anonymous, claim); drop it on successful logout.
  if (result.json?.data?.csrfToken) csrfTokens.set(page, result.json.data.csrfToken);
  if (pathName === '/api/auth/logout' && result.status === 200) csrfTokens.delete(page);
  return result;
}

// Same as api() but deliberately WITHOUT any CSRF header.
export async function apiNoCsrf(page, method, pathName, body) {
  return page.evaluate(async ({ method, pathName, body }) => {
    const res = await fetch(pathName, {
      method, credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  }, { method, pathName, body });
}

export async function apiMe(page) {
  const r = await api(page, 'GET', '/api/auth/me');
  expect(r.status, `GET /me should be 200 (got ${r.status}: ${r.text.slice(0, 200)})`).toBe(200);
  return r.json.data.user;
}

// Register a fresh password account through the real UI. Returns the user
// object from /api/auth/me (id + nexoraId + displayName) plus the email
// used (test-only, so a later test can sign back in through the UI).
export async function registerViaUI(page, displayName) {
  const email = `${uniq('bw')}@nexora.local`;
  // networkidle: the app re-renders the auth view when its boot probe
  // (GET /api/auth/me -> 401) resolves; filling before that wipes inputs.
  await page.goto(`${baseUrl()}/`, { waitUntil: 'networkidle' });
  // Registration inputs live in the "Create account" card on the auth view.
  const card = page.locator('.c', { hasText: 'Create account' });
  await card.getByLabel('Email').fill(email);
  await card.getByLabel('Password').fill('Password123!x');
  await card.getByLabel('Display name').fill(displayName);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  // Capture the session token now: the register response set the cookie
  // to it, and any later reload would overwrite the cookie (see above).
  await captureCsrf(page);
  const user = await apiMe(page);
  return { ...user, email };
}

// Anonymous identity through the real UI. Returns the user from /me.
export async function anonViaUI(page) {
  await page.goto(`${baseUrl()}/`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Continue anonymously' }).click();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await captureCsrf(page);
  return apiMe(page);
}

// Switch to a tab via the bottom/side nav and wait for its heading/content.
export async function goTab(page, label) {
  await page.getByRole('button', { name: label, exact: true }).click();
}

// Open a conversation from the Chats list by its visible title text.
export async function openConversationByTitle(page, title) {
  await goTab(page, 'Chats');
  await page.locator('.c', { hasText: title }).first().click();
  await expect(page.locator('#in')).toBeVisible();
}

export async function sendChatMessage(page, text) {
  await page.locator('#in').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#ml')).toContainText(text);
}

// Socket.IO join from inside the page using the global `io` loaded by the
// frontend (same-origin, cookie auth). Resolves the server ack object.
export async function socketJoin(page, conversationId) {
  return page.evaluate(async (conversationId) => {
    const socket = io({ withCredentials: true });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket connect timeout')), 10000);
    });
    const ack = await new Promise((resolve) => socket.emit('conversation:join', conversationId, resolve));
    socket.disconnect();
    return ack;
  }, conversationId);
}

// Upload a file to a conversation via the browser (multipart, session cookie).
// Returns { status, json }. `bytes` is a base64 string (page-safe transport).
// Uses the remembered session token, not the cookie (see captureCsrf).
export async function uploadViaBrowser(page, conversationId, { name, mime, base64 }) {
  const stored = csrfTokens.get(page) || '';
  return page.evaluate(async ({ conversationId, name, mime, base64, stored }) => {
    const cookieRaw = (document.cookie.split('; ').find((c) => c.startsWith('nx_csrf=')) || '').split('=')[1] || '';
    const csrf = stored || (cookieRaw ? decodeURIComponent(cookieRaw) : '');
    const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('file', new File([bin], name, { type: mime }));
    const res = await fetch(`/api/files/conversations/${conversationId}/upload`, {
      method: 'POST', credentials: 'include',
      headers: { 'X-CSRF-Token': csrf }, body: fd,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  }, { conversationId, name, mime, base64, stored });
}

// Download bytes via the browser session. Returns { status, base64 }.
export async function downloadViaBrowser(page, url) {
  return page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    const buf = new Uint8Array(await res.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.slice(i, i + 8192));
    return { status: res.status, base64: btoa(s) };
  }, url);
}
