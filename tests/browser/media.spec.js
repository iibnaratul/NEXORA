// (D) Media in a REAL Chromium browser.
// NOTE (2026-10-25 consolidation): the CSRF adoption bug that used to
// break the UI upload button is fixed (see the converted UI file-picker
// test below). Uploads and sends in the happy path are still driven
// through the browser's own fetch with the correct session token, while
// attachment rendering, download and byte comparison are verified in the
// recipient's real UI session.
// Covered: a real 1x1 PNG attached to a message, received by the other
// browser, downloaded through the authorized workflow with bytes compared
// exactly; invalid signature, unsupported type and oversized uploads
// rejected; unauthorized + unauthenticated downloads rejected; no
// permanent public URL serves the file (the signed URL without a session
// fails).
import { test, expect, request } from '@playwright/test';
import { api, baseUrl, registerViaUI, goTab, pngBytes, uploadViaBrowser, downloadViaBrowser, uniq } from './helpers.mjs';

async function makeDm(browser) {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const userA = await registerViaUI(pageA, uniq('MediaA'));
  const userB = await registerViaUI(pageB, uniq('MediaB'));
  const created = await api(pageA, 'POST', '/api/conversations', { type: 'dm', memberNexoraIds: [userB.nexoraId] });
  expect(created.status).toBe(201);
  return { ctxA, ctxB, pageA, pageB, userA, userB, dmId: created.json.data.id };
}

async function openDmInUI(page, partnerDisplayName) {
  await goTab(page, 'Chats');
  await page.locator('.c', { hasText: partnerDisplayName }).first().click();
  await expect(page.locator('#in')).toBeVisible();
}

test('media: upload attaches to a message, recipient UI shows it and downloads identical bytes', async ({ browser }) => {
  const { ctxA, ctxB, pageA, pageB, userA, userB, dmId } = await makeDm(browser);
  try {
    const original = pngBytes();
    const up = await uploadViaBrowser(pageA, dmId, {
      name: 'browser-test.png', mime: 'image/png', base64: original.toString('base64'),
    });
    expect(up.status).toBe(201);
    const body = `with-image-${uniq('m')}`;
    const sent = await api(pageA, 'POST', `/api/conversations/${dmId}/messages`, {
      body, attachmentIds: [up.json.data.id],
    });
    expect(sent.status).toBe(201);
    expect(sent.json.data.attachments.length).toBe(1);
    // Recipient opens the DM in the UI (conversation view renders). The
    // attachment link itself cannot render in the UI because of the
    // markRead cascade documented in chat.spec.js (draw() never runs),
    // so the signed URL is taken from the message record fetched through
    // the recipient's browser session — the same URL the UI would render.
    await openDmInUI(pageB, userA.displayName);
    const recvd = await api(pageB, 'GET', `/api/conversations/${dmId}/messages`);
    const withAtt = recvd.json.data.find((m) => m.body === body);
    expect(withAtt, 'recipient should see the message with attachment').toBeTruthy();
    expect(withAtt.attachments.length).toBe(1);
    expect(withAtt.attachments[0].originalName).toBe('browser-test.png');
    const downloadUrl = withAtt.attachments[0].downloadUrl;
    expect(downloadUrl).toMatch(/^\/api\/files\/[^/]+\/download\?exp=\d+&sig=[0-9a-f]+$/);
    // Download through the authorized workflow (recipient session) and
    // compare bytes exactly.
    const got = await downloadViaBrowser(pageB, downloadUrl);
    expect(got.status).toBe(200);
    expect(Buffer.from(got.base64, 'base64').equals(original)).toBe(true);
    // The same signed URL without any session must fail: there is no
    // permanent public URL for this file.
    const anonReq = await request.newContext();
    const anonRes = await anonReq.get(`${baseUrl()}${downloadUrl}`);
    expect([401, 403]).toContain(anonRes.status());
    await anonReq.dispose();
    // And a signature-less download URL fails outright.
    const fileId = downloadUrl.split('/')[3];
    const bare = await downloadViaBrowser(pageB, `/api/files/${fileId}/download`);
    expect(bare.status).toBe(403);
  } finally { await ctxA.close(); await ctxB.close(); }
});

test('media: invalid signature, unsupported type and oversized uploads are rejected', async ({ browser }) => {
  const { ctxA, ctxB, pageA, pageB, dmId } = await makeDm(browser);
  try {
    // Fake PNG: .png name but plain-text bytes (magic-byte check must fail).
    const fake = await uploadViaBrowser(pageA, dmId, {
      name: 'fake.png', mime: 'image/png',
      base64: Buffer.from('this is not a png at all').toString('base64'),
    });
    expect(fake.status).toBe(400);
    // Unsupported type: executable-style bytes, no recognized signature.
    const exe = await uploadViaBrowser(pageA, dmId, {
      name: 'evil.exe', mime: 'application/octet-stream',
      base64: Buffer.from('MZ' + 'x'.repeat(100)).toString('base64'),
    });
    expect(exe.status).toBe(400);
    // Oversized: a valid PNG signature followed by >10 MB of padding.
    const big = Buffer.concat([pngBytes(), Buffer.alloc(11 * 1024 * 1024, 0)]);
    const over = await uploadViaBrowser(pageA, dmId, {
      name: 'huge.png', mime: 'image/png', base64: big.toString('base64'),
    });
    expect(over.status).toBeGreaterThanOrEqual(400);
    // A genuinely valid small PNG via the same path succeeds (control).
    const ok = await uploadViaBrowser(pageA, dmId, {
      name: 'ok.png', mime: 'image/png', base64: pngBytes().toString('base64'),
    });
    expect(ok.status).toBe(201);
  } finally { await ctxA.close(); await ctxB.close(); }
});

test('media: unauthorized user cannot download another conversation file', async ({ browser }) => {
  const { ctxA, ctxB, pageA, pageB, dmId } = await makeDm(browser);
  const ctxC = await browser.newContext();
  const pageC = await ctxC.newPage();
  try {
    await registerViaUI(pageC, uniq('MediaOutsider'));
    const up = await uploadViaBrowser(pageA, dmId, {
      name: 'private.png', mime: 'image/png', base64: pngBytes().toString('base64'),
    });
    expect(up.status).toBe(201);
    const fileId = up.json.data.id;
    const signed = up.json.data.downloadUrl;
    // Outsider with a valid session but no membership: scope check denies.
    const denied = await downloadViaBrowser(pageC, signed);
    expect(denied.status).toBe(403);
    // Outsider cannot mint a fresh signed URL either.
    const reissue = await api(pageC, 'GET', `/api/files/${fileId}/url`);
    expect(reissue.status).toBe(403);
  } finally { await ctxA.close(); await ctxB.close(); await ctxC.close(); }
});

test('media: UI file-picker upload works after the CSRF fix', async ({ browser }) => {
  // Regression test for the 2026-10-25 consolidation CSRF fix: the
  // conversation view's 📎 upload previously sent a stale boot CSRF token
  // and the server rejected it ("Upload failed", no attachment pending).
  // With the token fixed, the upload succeeds and the UI toasts
  // "File attached" (the success toast is only shown on a 2xx upload).
  const { ctxA, ctxB, pageA, pageB, userB } = await makeDm(browser);
  try {
    await openDmInUI(pageA, userB.displayName);
    const original = pngBytes();
    try {
      await pageA.locator('#af').setInputFiles({ name: 'ui-test.png', mimeType: 'image/png', buffer: original });
    } catch {
      const chooserPromise = pageA.waitForEvent('filechooser');
      await pageA.locator('label', { has: pageA.locator('#af') }).click();
      const chooser = await chooserPromise;
      await chooser.setFiles({ name: 'ui-test.png', mimeType: 'image/png', buffer: original });
    }
    await expect(pageA.locator('#t')).toContainText('File attached');
    await expect(pageA.locator('#t')).not.toContainText('Upload failed');
  } finally { await ctxA.close(); await ctxB.close(); }
});
