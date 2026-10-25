import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session, pngBytes } from '../helpers.js';

let srv, alice, bob;
test.before(async () => {
  srv = await startTestServer();
  alice = new Session(srv.baseUrl); await alice.initCsrf();
  bob = new Session(srv.baseUrl); await bob.initCsrf();
  await alice.anonymous('Alice');
  await bob.anonymous('Bob');
});
test.after(async () => { if (srv) await srv.close(); });

async function roomWithBoth() {
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'Files Room' });
  const id = room.json.data.id;
  await bob.req('POST', `/api/conversations/${id}/join`, {});
  return id;
}

function formFile(buffer, filename) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer]), filename);
  return fd;
}

test('upload a real PNG, attach it, download via signed URL', async () => {
  const convId = await roomWithBoth();
  const up = await alice.req('POST', `/api/files/conversations/${convId}/upload`, formFile(pngBytes(), 'pic.png'), { form: true });
  assert.equal(up.status, 201);
  const fileId = up.json.data.id;
  const sent = await alice.req('POST', `/api/conversations/${convId}/messages`, {
    body: 'with photo', attachmentIds: [fileId],
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.json.data.attachments.length, 1);
  // Bob (member) can download through the signed URL.
  const url = sent.json.data.attachments[0].downloadUrl;
  const dl = await bob.req('GET', url);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-type'), /png/);
});

test('fake PNG (text bytes) is rejected regardless of filename', async () => {
  const convId = await roomWithBoth();
  const up = await alice.req('POST', `/api/files/conversations/${convId}/upload`,
    formFile(Buffer.from('hello, I am not a png'), 'evil.png'), { form: true });
  assert.equal(up.status, 400);
});

test('non-member cannot upload or download', async () => {
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'Private-ish' });
  const convId = room.json.data.id;
  // Bob has not joined.
  const up = await bob.req('POST', `/api/files/conversations/${convId}/upload`, formFile(pngBytes(), 'x.png'), { form: true });
  assert.equal(up.status, 403);
  // Alice uploads, then Bob (still not a member) cannot use her signed URL.
  const ok = await alice.req('POST', `/api/files/conversations/${convId}/upload`, formFile(pngBytes(), 'x.png'), { form: true });
  const url = ok.json.data.downloadUrl;
  assert.equal((await bob.req('GET', url)).status, 403);
});

test('expired signed URL is rejected', async () => {
  const convId = await roomWithBoth();
  const up = await alice.req('POST', `/api/files/conversations/${convId}/upload`, formFile(pngBytes(), 'x.png'), { form: true });
  const fileId = up.json.data.id;
  const expired = `/api/files/${fileId}/download?exp=${Date.now() - 1000}&sig=deadbeef`;
  assert.equal((await alice.req('GET', expired)).status, 403);
});

test('parcel photo: sender only, images only', async () => {
  const order = await alice.req('POST', '/api/deliveries', {
    name: 'Photo parcel', category: 'Documents', size: 'Small (fits a bag)',
    pickupArea: 'A', dropoffArea: 'B',
  });
  const id = order.json.data.id;
  assert.equal((await bob.req('POST', `/api/files/deliveries/${id}/photo`, formFile(pngBytes(), 'p.png'), { form: true })).status, 403);
  const bad = await alice.req('POST', `/api/files/deliveries/${id}/photo`,
    formFile(Buffer.from('%PDF-1.4 not an image'), 'doc.pdf'), { form: true });
  assert.equal(bad.status, 400, 'parcel photo must be an image, not any file');
  const good = await alice.req('POST', `/api/files/deliveries/${id}/photo`, formFile(pngBytes(), 'p.png'), { form: true });
  assert.equal(good.status, 201);
});
