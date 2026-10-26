// (E) Marketplace delivery in a REAL Chromium browser, two contexts
// (buyer + seller). State transitions are driven through the browser's own
// fetch (same origin, same session, same server code path, as in
// delivery.spec.js); the final DELIVERED state and the cash payment record
// are additionally asserted in the seller's UI detail page after a reload.
// Flow: request -> accept -> prepare -> photo + drop-off pin -> arrive ->
// handover + cash record. The drop-off photo is uploaded through the
// browser (multipart) exactly as the frontend does.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, registerViaUI, goTab, uniq, pngBytes } from './helpers.mjs';

const artifacts = path.join(path.dirname(fileURLToPath(import.meta.url)), 'artifacts');

// Multipart delivery-photo upload from inside the page (mirrors the
// frontend's uploadParcelPhoto: POST /api/files/deliveries/:id/photo).
async function uploadDeliveryPhoto(page, deliveryId, base64) {
  return page.evaluate(async ({ deliveryId, base64 }) => {
    const cookieRaw = (document.cookie.split('; ').find((c) => c.startsWith('nx_csrf=')) || '').split('=')[1] || '';
    const csrf = cookieRaw ? decodeURIComponent(cookieRaw) : '';
    const bin = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('file', new File([bin], 'dropoff.png', { type: 'image/png' }));
    const res = await fetch(`/api/files/deliveries/${deliveryId}/photo`, {
      method: 'POST', credentials: 'include',
      headers: { 'X-CSRF-Token': csrf }, body: fd,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  }, { deliveryId, base64 });
}

async function deliveryStatus(page, id) {
  const r = await api(page, 'GET', `/api/deliveries/${id}`);
  return { status: r.status, state: r.json?.data?.status, data: r.json?.data };
}

test('marketplace: request -> accept -> prepare -> photo+pin -> arrive -> handover + cash record', async ({ browser }) => {
  const ctxBuyer = await browser.newContext();
  const ctxSeller = await browser.newContext();
  const pageBuyer = await ctxBuyer.newPage();
  const pageSeller = await ctxSeller.newPage();
  try {
    const seller = await registerViaUI(pageSeller, uniq('Seller'));
    const buyer = await registerViaUI(pageBuyer, uniq('Buyer'));
    // Buyer opens a DM with the seller and requests an item.
    const dm = await api(pageBuyer, 'POST', '/api/conversations', {
      type: 'dm', memberNexoraIds: [seller.nexoraId],
    });
    expect(dm.status, `DM create (got ${dm.status}: ${dm.text.slice(0, 200)})`).toBe(201);
    const convId = dm.json.data.id;
    const title = uniq('MktItem');
    const created = await api(pageBuyer, 'POST', '/api/delivery-requests', {
      conversationId: convId, targetId: seller.id, title,
      description: 'A5 dotted notebook, blue cover', priceMinor: 50000,
    });
    expect(created.status, `request create (got ${created.status}: ${created.text.slice(0, 200)})`).toBe(201);
    const requestId = created.json.data.id;
    expect(created.json.data.status).toBe('REQUESTED');
    // Seller accepts: a CREATED marketplace delivery appears.
    const accepted = await api(pageSeller, 'POST', `/api/delivery-requests/${requestId}/accept`, {});
    expect(accepted.status).toBe(200);
    expect(accepted.json.data.status).toBe('ACCEPTED');
    const deliveryId = accepted.json.data.delivery.id;
    expect(accepted.json.data.delivery.fulfillment).toBe('marketplace');
    expect(accepted.json.data.delivery.sender_id).toBe(seller.id);
    // Seller prepares, uploads a drop-off photo, and sets the pin.
    const prep = await api(pageSeller, 'POST', `/api/deliveries/${deliveryId}/prepare`, {});
    expect(prep.status).toBe(200);
    expect((await deliveryStatus(pageSeller, deliveryId)).state).toBe('PREPARED');
    const up = await uploadDeliveryPhoto(pageSeller, deliveryId, pngBytes().toString('base64'));
    expect(up.status, `photo upload (got ${up.status}: ${up.text.slice(0, 200)})`).toBe(201);
    const drop = await api(pageSeller, 'PATCH', `/api/deliveries/${deliveryId}/dropoff`, {
      dropoffLat: 23.81, dropoffLng: 90.41, dropoffArea: 'Savar Bazar',
      dropoffPhotoFileId: up.json.data.id, dropoffCoordSource: 'user-supplied',
    });
    expect(drop.status, `dropoff (got ${drop.status}: ${drop.text.slice(0, 200)})`).toBe(200);
    expect(drop.json.data.status).toBe('READY_FOR_PICKUP');
    const detail = await deliveryStatus(pageBuyer, deliveryId);
    expect(detail.state).toBe('READY_FOR_PICKUP');
    expect(detail.data.dropoff_photo_file_id).toBe(up.json.data.id);
    expect(detail.data.dropoff_photo_url).toBeTruthy();
    expect(detail.data.buyer_id).toBe(buyer.id);
    // Buyer sees only the pickup code, confirms arrival, seller hands over.
    const codes = await api(pageBuyer, 'GET', `/api/deliveries/${deliveryId}/codes`);
    expect(codes.status).toBe(200);
    expect(Object.keys(codes.json.data)).toEqual(['pickup']);
    const code = codes.json.data.pickup.code;
    expect(code).toMatch(/^\d{6}$/);
    const arrived = await api(pageBuyer, 'POST', `/api/deliveries/${deliveryId}/arrive`, {});
    expect(arrived.status).toBe(200);
    expect(arrived.json.data.status).toBe('READY_FOR_PICKUP');
    const hand = await api(pageSeller, 'POST', `/api/deliveries/${deliveryId}/handover`, { code });
    expect(hand.status).toBe(200);
    expect(hand.json.data.status).toBe('DELIVERED');
    expect(hand.json.data.recordOnly).toBe(true);
    expect(hand.json.data.payment.amount_minor).toBe(50000);
    expect(hand.json.data.payment.currency).toBe('BDT');
    expect(hand.json.data.payment.method).toBe('cash');
    expect(hand.json.data.payment.payer_id).toBe(buyer.id);
    expect(hand.json.data.payment.payee_id).toBe(seller.id);
    expect((await deliveryStatus(pageSeller, deliveryId)).state).toBe('DELIVERED');
    // Persistence + UI: seller reloads, opens the order, sees the
    // "Item Exchanged" completion label for the DELIVERED marketplace
    // order (area 4 display label; API state stays DELIVERED, asserted
    // above) and the cash payment record (amount renders from amount_minor).
    await pageSeller.reload();
    await goTab(pageSeller, 'Delivery');
    await pageSeller.getByRole('button', { name: /My orders/ }).click();
    await pageSeller.locator('.c', { hasText: title }).first().click();
    await expect(pageSeller.locator('main')).toContainText('Ref:');
    await expect(pageSeller.locator('main')).toContainText(title);
    await expect(pageSeller.locator('main')).toContainText('Item Exchanged');
    await expect(pageSeller.locator('main')).toContainText('Cash payment record');
    await expect(pageSeller.locator('main')).toContainText('50000');
    await pageSeller.screenshot({ path: path.join(artifacts, 'marketplace-delivered.png') });
  } finally {
    await ctxBuyer.close();
    await ctxSeller.close();
  }
});
