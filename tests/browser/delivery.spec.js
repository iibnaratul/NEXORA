// (E) TRANSIT lifecycle in a REAL Chromium browser, two contexts
// (sender + courier).
// NOTE (2026-10-25 consolidation): the CSRF adoption bug that used to
// break UI mutations is fixed; UI-click mutations are covered by
// ui-mutations.spec.js. State transitions in this spec are still driven
// through the browser's own fetch with the correct session token (same
// origin, same session, same server code path), while every status
// observation below is also checked in the UI:
// the sender's and courier's detail pages render the order, and the final
// 8-step timeline is asserted in the UI after a refresh. One Playwright
// trace of the happy path is captured. Handover codes are read from the
// sender's own detail page (the UI shows them to the sender) and are
// never logged.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, registerViaUI, goTab, uniq } from './helpers.mjs';

const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');

async function createOrder(page, name) {
  const r = await api(page, 'POST', '/api/deliveries', {
    name, category: 'Documents', size: 'Small (fits a bag)',
    pickupArea: 'Savar', dropoffArea: 'Dhanmondi',
  });
  expect(r.status, `order create should succeed (got ${r.status}: ${r.text.slice(0, 200)})`).toBe(201);
  return r.json.data.id;
}

async function deliveryStatus(page, id) {
  const r = await api(page, 'GET', `/api/deliveries/${id}`);
  return { status: r.status, state: r.json?.data?.status };
}

async function waitStatus(page, id, wanted) {
  await expect.poll(async () => (await deliveryStatus(page, id)).state).toBe(wanted);
}

// Open the order's detail page in the UI (via the Delivery tab lists).
// Waits for 'Ref:' — detail-only text — because the list already contains
// the order name, so waiting on the name alone would pass too early.
async function openOrderInUI(page, orderName, mineTab) {
  await goTab(page, 'Delivery');
  if (mineTab) await page.getByRole('button', { name: /My orders/ }).click();
  await page.locator('.c', { hasText: orderName }).first().click();
  await expect(page.locator('main')).toContainText('Ref:');
  await expect(page.locator('main')).toContainText(orderName);
}

async function senderCodesFromUI(page) {
  const text = await page.evaluate(() => document.querySelector('#cc')?.textContent || '');
  const pickup = text.match(/Pickup \(give to courier\):\s*(\d{6})/)?.[1];
  const dropoff = text.match(/Delivery \(give to recipient\):\s*(\d{6})/)?.[1];
  expect(pickup, 'sender page should show a pickup code').toMatch(/^\d{6}$/);
  expect(dropoff, 'sender page should show a delivery code').toMatch(/^\d{6}$/);
  return { pickup, dropoff };
}

async function registerCourierViaUI(page, display) {
  await registerViaUI(page, display);
  // Register through the browser's own fetch for setup brevity (the UI
  // button works too since the 2026-10-25 CSRF fix), then reload so the
  // Profile UI loads the courier profile and shows it.
  const reg = await api(page, 'POST', '/api/couriers/register', {});
  expect(reg.status).toBe(200);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible();
  await goTab(page, 'Profile');
  await expect(page.locator('main')).toContainText('Registered courier');
}

test('delivery: full lifecycle in the browser, delivered persists after refresh', async ({ browser }) => {
  const ctxSender = await browser.newContext();
  const ctxCourier = await browser.newContext();
  const pageSender = await ctxSender.newPage();
  const pageCourier = await ctxCourier.newPage();
  try {
    await ctxCourier.tracing.start({ screenshots: true, snapshots: true, sources: false });
    await registerViaUI(pageSender, uniq('Sender'));
    await registerCourierViaUI(pageCourier, uniq('Courier'));
    const orderName = uniq('BrowserParcel');
    const orderId = await createOrder(pageSender, orderName);
    expect((await deliveryStatus(pageSender, orderId)).state).toBe('SEARCHING_FOR_COURIER');
    // Sender opens the order in the UI; the UI shows the handover codes.
    await openOrderInUI(pageSender, orderName, true);
    const codes = await senderCodesFromUI(pageSender);
    // Courier opens the order from the queue in the UI, then claims.
    await openOrderInUI(pageCourier, orderName, false);
    const claim = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/claim`, {});
    expect(claim.status).toBe(200);
    await waitStatus(pageCourier, orderId, 'ASSIGNED');
    const accept = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/step`, { to: 'ACCEPTED' });
    expect(accept.status).toBe(200);
    await waitStatus(pageCourier, orderId, 'ACCEPTED');
    // Pickup verification with the sender's code.
    const pickup = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/verify`, { stage: 'pickup', code: codes.pickup });
    expect(pickup.status).toBe(200);
    await waitStatus(pageCourier, orderId, 'PICKUP_VERIFIED');
    const transit = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/step`, { to: 'IN_TRANSIT' });
    expect(transit.status).toBe(200);
    await waitStatus(pageCourier, orderId, 'IN_TRANSIT');
    // Drop-off verification with the recipient code.
    const dropoff = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/verify`, { stage: 'dropoff', code: codes.dropoff });
    expect(dropoff.status).toBe(200);
    await waitStatus(pageCourier, orderId, 'DROPOFF_VERIFIED');
    const delivered = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/step`, { to: 'DELIVERED' });
    expect(delivered.status).toBe(200);
    await waitStatus(pageCourier, orderId, 'DELIVERED');
    // Persistence: sender reloads, reopens the order in the UI, still
    // DELIVERED, and the full 8-step timeline is marked complete in the UI.
    await pageSender.reload();
    await openOrderInUI(pageSender, orderName, true);
    expect((await deliveryStatus(pageSender, orderId)).state).toBe('DELIVERED');
    await expect(pageSender.locator('ol li.on')).toHaveCount(8);
    const history = await api(pageSender, 'GET', `/api/deliveries/${orderId}/history`);
    expect(history.json.data.at(-1).to_status).toBe('DELIVERED');
    await pageSender.screenshot({ path: path.join(artifacts, 'delivery-delivered.png') });
    await ctxCourier.tracing.stop({ path: path.join(artifacts, 'delivery-happy-path-trace.zip') });
  } finally {
    try { await ctxCourier.tracing.stop({ path: path.join(artifacts, 'delivery-happy-path-trace.zip') }); } catch { /* already stopped */ }
    await ctxSender.close();
    await ctxCourier.close();
  }
});

test('delivery: invalid transitions rejected, unrelated users cannot view/modify', async ({ browser }) => {
  const ctxSender = await browser.newContext();
  const ctxCourier = await browser.newContext();
  const ctxOther = await browser.newContext();
  const pageSender = await ctxSender.newPage();
  const pageCourier = await ctxCourier.newPage();
  const pageOther = await ctxOther.newPage();
  try {
    await registerViaUI(pageSender, uniq('Sender2'));
    await registerCourierViaUI(pageCourier, uniq('Courier2'));
    await registerViaUI(pageOther, uniq('Unrelated'));
    const orderName = uniq('InvalidParcel');
    const orderId = await createOrder(pageSender, orderName);
    // Skip-ahead step from SEARCHING_FOR_COURIER is rejected.
    const skip = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/step`, { to: 'DELIVERED' });
    expect(skip.status).toBeGreaterThanOrEqual(400);
    // Sender (not the courier) cannot step the order.
    const senderStep = await api(pageSender, 'POST', `/api/deliveries/${orderId}/step`, { to: 'ACCEPTED' });
    expect(senderStep.status).toBeGreaterThanOrEqual(400);
    // Claim, then a code step without a code is rejected.
    const claim = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/claim`, {});
    expect(claim.status).toBe(200);
    const codeViaStep = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/step`, { to: 'PICKUP_VERIFIED' });
    expect(codeViaStep.status).toBeGreaterThanOrEqual(400);
    // Accept, then a wrong pickup code is rejected and state does not move.
    const accept = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/step`, { to: 'ACCEPTED' });
    expect(accept.status).toBe(200);
    const wrongCode = await api(pageCourier, 'POST', `/api/deliveries/${orderId}/verify`, { stage: 'pickup', code: '000000' });
    expect(wrongCode.status).toBeGreaterThanOrEqual(400);
    expect((await deliveryStatus(pageCourier, orderId)).state).toBe('ACCEPTED');
    // Unrelated user: no view, no claim, no step, no codes.
    const view = await api(pageOther, 'GET', `/api/deliveries/${orderId}`);
    expect(view.status).toBe(403);
    const hist = await api(pageOther, 'GET', `/api/deliveries/${orderId}/history`);
    expect(hist.status).toBe(403);
    const otherClaim = await api(pageOther, 'POST', `/api/deliveries/${orderId}/claim`, {});
    expect(otherClaim.status).toBeGreaterThanOrEqual(400);
    const otherStep = await api(pageOther, 'POST', `/api/deliveries/${orderId}/step`, { to: 'IN_TRANSIT' });
    expect(otherStep.status).toBeGreaterThanOrEqual(400);
    const otherCodes = await api(pageOther, 'GET', `/api/deliveries/${orderId}/codes`);
    expect(otherCodes.status).toBe(403);
  } finally {
    await ctxSender.close();
    await ctxCourier.close();
    await ctxOther.close();
  }
});
