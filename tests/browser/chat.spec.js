// (C) Real-time chat with TWO separate browser contexts (two users).
// NOTE (2026-10-25 consolidation): the CSRF adoption bug that used to
// break all UI mutations is fixed (api.js adopts csrfToken; /api/auth/csrf
// returns the session token when authenticated), and UI-click mutations
// are covered by ui-mutations.spec.js. Mutations in THIS spec are still
// driven through the browser's own fetch with the correct session token
// (same origin, same session, same server code path) so the socket,
// persistence, and access-control assertions stay independent of UI
// button behavior. The socket proof uses a socket opened from inside the
// recipient's own browser page (window.io, same session cookies) — a
// real browser Socket.IO event, not API polling (the frontend has no
// message polling) — plus API persistence and UI navigation checks.
// Covered: private DM creation, socket delivery to the other browser,
// persistence after refresh on both sides, non-member denial (HTTP +
// socket join), group create/invite/add, and removal: the removed member
// immediately loses HTTP + socket access (verified by reusing that
// member's own browser context).
import { test, expect } from '@playwright/test';
import { api, registerViaUI, goTab, socketJoin, uniq } from './helpers.mjs';

async function setupTwoUsers(browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const userA = await registerViaUI(pageA, uniq('ChatA'));
  const userB = await registerViaUI(pageB, uniq('ChatB'));
  return { ctxA, ctxB, pageA, pageB, userA, userB };
}

// Create a DM (browser fetch, correct session token) and open it in A's UI.
async function createDm(pageA, partnerNexoraId) {
  const r = await api(pageA, 'POST', '/api/conversations', { type: 'dm', memberNexoraIds: [partnerNexoraId] });
  expect(r.status, `DM create should succeed (got ${r.status}: ${r.text.slice(0, 200)})`).toBe(201);
  return r.json.data.id;
}

async function openDmInUI(page, partnerDisplayName) {
  await goTab(page, 'Chats');
  await page.locator('.c', { hasText: partnerDisplayName }).first().click();
  await expect(page.locator('#in')).toBeVisible();
}

// Join a conversation from inside a page via the global `io` the frontend
// itself loads, and arm a one-shot wait for the next message:new event.
// arm MUST be awaited before the sender sends — otherwise the send can
// beat the join and the event is missed (a real race, not a server bug).
async function armSocketWait(page, conversationId) {
  await page.evaluate(async (conversationId) => {
    const socket = io({ withCredentials: true });
    await new Promise((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      setTimeout(() => reject(new Error('socket connect timeout')), 10000);
    });
    const ack = await new Promise((resolve) => socket.emit('conversation:join', conversationId, resolve));
    if (!ack?.ok) throw new Error(`socket join failed: ${JSON.stringify(ack)}`);
    window.__browserSocket = socket;
    window.__browserSocketMessage = new Promise((resolve) => {
      socket.on('message:new', resolve);
      setTimeout(() => resolve(null), 15000);
    });
  }, conversationId);
}
async function awaitSocketMessage(page) {
  return page.evaluate(async () => {
    const m = await window.__browserSocketMessage;
    window.__browserSocket?.disconnect();
    return m ? m.body : null;
  });
}

test('chat: two browsers, DM message arrives via Socket.IO without reload, persists after refresh', async ({ browser }) => {
  const { ctxA, ctxB, pageA, pageB, userA, userB } = await setupTwoUsers(browser);
  try {
    const dmId = await createDm(pageA, userB.nexoraId);
    // Recipient opens the DM in the UI (conversation view renders; the
    // message list itself stays empty because of the markRead cascade
    // documented below — the socket proof does not depend on it).
    await openDmInUI(pageB, userA.displayName);
    // Arm a socket inside the recipient's browser page FIRST (awaited,
    // so the join is confirmed), then send.
    await armSocketWait(pageB, dmId);
    const body = `socket-proof-${uniq('msg')}`;
    const sent = await api(pageA, 'POST', `/api/conversations/${dmId}/messages`, { body });
    expect(sent.status).toBe(201);
    // The recipient BROWSER receives the actual Socket.IO event, with no
    // reload and no polling.
    expect(await awaitSocketMessage(pageB)).toBe(body);
    // Persistence: refresh both, reopen in the UI, message still there
    // (verified through the recipient's browser session).
    await pageA.reload();
    await pageB.reload();
    await openDmInUI(pageA, userB.displayName);
    await openDmInUI(pageB, userA.displayName);
    const msgs = await api(pageB, 'GET', `/api/conversations/${dmId}/messages?limit=80&page=1`);
    expect(msgs.status).toBe(200);
    expect(msgs.json.data.some((m) => m.body === body)).toBe(true);
  } finally { await ctxA.close(); await ctxB.close(); }
});

test('chat: opening a conversation in the UI renders messages (openConv fix)', async ({ browser }) => {
  // Regression test for the 2026-10-25 consolidation fixes: openConv()
  // previously awaited a markRead POST that failed with 403 CSRF_INVALID
  // BEFORE draw() and BEFORE the socket join, so the message list stayed
  // an empty skeleton forever. markRead is now best-effort (and the CSRF
  // token itself is correct), so opening the conversation renders the
  // messages that exist server-side.
  const { ctxA, ctxB, pageA, pageB, userA, userB } = await setupTwoUsers(browser);
  try {
    const dmId = await createDm(pageA, userB.nexoraId);
    const body = `now-rendered-${uniq('m')}`;
    const sent = await api(pageA, 'POST', `/api/conversations/${dmId}/messages`, { body });
    expect(sent.status).toBe(201);
    await openDmInUI(pageB, userA.displayName);
    await expect(pageB.locator('#ml')).toContainText(body);
    await expect(pageB.locator('#t')).toBeHidden();
    // Server-side, the message is really there (as is the UI rendering).
    const msgs = await api(pageB, 'GET', `/api/conversations/${dmId}/messages`);
    expect(msgs.json.data.some((m) => m.body === body)).toBe(true);
  } finally { await ctxA.close(); await ctxB.close(); }
});

test('chat: non-member cannot read/send/subscribe (HTTP + socket)', async ({ browser }) => {
  const { ctxA, ctxB, pageA, pageB, userA, userB } = await setupTwoUsers(browser);
  const ctxC = await browser.newContext();
  const pageC = await ctxC.newPage();
  try {
    const dmId = await createDm(pageA, userB.nexoraId);
    const outsider = await registerViaUI(pageC, uniq('Outsider'));
    expect(outsider.id).not.toBe(userA.id);
    expect(outsider.id).not.toBe(userB.id);
    const read = await api(pageC, 'GET', `/api/conversations/${dmId}`);
    expect(read.status).toBe(403);
    const msgs = await api(pageC, 'GET', `/api/conversations/${dmId}/messages`);
    expect(msgs.status).toBe(403);
    const send = await api(pageC, 'POST', `/api/conversations/${dmId}/messages`, { body: 'intruder' });
    expect(send.status).toBe(403);
    const ack = await socketJoin(pageC, dmId);
    expect(ack.ok).toBe(false);
  } finally { await ctxA.close(); await ctxB.close(); await ctxC.close(); }
});

test('chat: group create/invite/add, then removed member loses HTTP + socket access immediately', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageC = await ctxC.newPage();
  try {
    const userA = await registerViaUI(pageA, uniq('GroupOwner'));
    const userB = await registerViaUI(pageB, uniq('GroupB'));
    const userC = await registerViaUI(pageC, uniq('GroupC'));
    // Owner creates a private group with B (browser fetch, for setup
    // brevity; UI creation is covered by ui-mutations.spec.js).
    const groupName = uniq('BrowserGroup');
    const created = await api(pageA, 'POST', '/api/conversations', {
      type: 'group', name: groupName, memberNexoraIds: [userB.nexoraId],
    });
    expect(created.status).toBe(201);
    const groupId = created.json.data.id;
    // Owner invites C; verify via the members list.
    const added = await api(pageA, 'POST', `/api/conversations/${groupId}/members`, { nexoraId: userC.nexoraId });
    expect(added.status).toBe(200);
    // C opens the group in the UI (member access works) and sends a message
    // (the UI message list stays empty because of the markRead cascade
    // documented above; the send itself is verified server-side).
    await openDmInUI(pageC, groupName);
    const beforeBody = `before-removal-${uniq('m')}`;
    const sent = await api(pageC, 'POST', `/api/conversations/${groupId}/messages`, { body: beforeBody });
    expect(sent.status).toBe(201);
    const check = await api(pageC, 'GET', `/api/conversations/${groupId}/messages`);
    expect(check.json.data.some((m) => m.body === beforeBody)).toBe(true);
    // Owner removes C (the UI has no remove-member affordance — the
    // removal itself is server-enforced and verified below).
    const removed = await api(pageA, 'DELETE', `/api/conversations/${groupId}/members/${userC.id}`);
    expect(removed.status).toBe(200);
    // Reusing C's own browser context: HTTP access is gone immediately.
    const read = await api(pageC, 'GET', `/api/conversations/${groupId}`);
    expect(read.status).toBe(403);
    const msgs = await api(pageC, 'GET', `/api/conversations/${groupId}/messages`);
    expect(msgs.status).toBe(403);
    const send = await api(pageC, 'POST', `/api/conversations/${groupId}/messages`, { body: 'after removal' });
    expect(send.status).toBe(403);
    // Socket re-join is also denied for the removed member.
    const ack = await socketJoin(pageC, groupId);
    expect(ack.ok).toBe(false);
    // After reload, the group disappears from C's chat list.
    await pageC.reload();
    await expect(pageC.locator('main')).not.toContainText(groupName);
    // Remaining members still have access.
    const stillOk = await api(pageB, 'GET', `/api/conversations/${groupId}`);
    expect(stillOk.status).toBe(200);
  } finally { await ctxA.close(); await ctxB.close(); await ctxC.close(); }
});
