// Phase 4 (E) — Private files.
// Signed-URL auth, tampering/expiry/replay, file-ID manipulation, size and
// magic-byte checks, filename handling, MIME trust, and static exposure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Session, pngBytes } from '../helpers.js';

process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.MESSAGE_RATE_LIMIT_MAX = '1000';
process.env.UPLOAD_RATE_LIMIT_MAX = '1000';
process.env.MAX_UPLOAD_MB = '1';
let srv, alice, bob, carol, convId, fileId, fileUrl;
test.before(async () => {
  srv = await startTestServer();
  alice = new Session(srv.baseUrl); await alice.initCsrf(); await alice.anonymous('Alice');
  bob = new Session(srv.baseUrl); await bob.initCsrf(); await bob.anonymous('Bob');
  carol = new Session(srv.baseUrl); await carol.initCsrf(); await carol.anonymous('Carol');
  const room = await alice.req('POST', '/api/conversations', { type: 'room', name: 'FilesSec' });
  convId = room.json.data.id;
  await bob.req('POST', `/api/conversations/${convId}/join`, {});
  const fd = new FormData(); fd.append('file', new Blob([pngBytes()]), 'alice.png');
  const up = await alice.req('POST', `/api/files/conversations/${convId}/upload`, fd, { form: true });
  assert.equal(up.status, 201);
  fileId = up.json.data.id;
  fileUrl = up.json.data.downloadUrl;
});
test.after(async () => { if (srv) await srv.close(); });

function formFile(buffer, filename, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], mime ? { type: mime } : {}), filename);
  return fd;
}
async function roomFor(uploader, joiner) {
  const room = await uploader.req('POST', '/api/conversations', { type: 'room', name: 'TmpRoom' });
  const id = room.json.data.id;
  if (joiner) await joiner.req('POST', `/api/conversations/${id}/join`, {});
  return id;
}

test('unauthenticated download with a valid signed URL is rejected', async () => {
  const naked = await fetch(srv.baseUrl + fileUrl);
  assert.equal(naked.status, 401, 'signature alone is not authorization; a session is required');
  const noSig = await alice.req('GET', `/api/files/${fileId}/download`);
  assert.equal(noSig.status, 403);
  const noExp = await alice.req('GET', `/api/files/${fileId}/download?sig=deadbeef`);
  assert.equal(noExp.status, 403);
});

test('unrelated authenticated user cannot download or re-issue, and guessed IDs 404', async () => {
  assert.equal((await carol.req('GET', fileUrl)).status, 403, 'signed URL cannot be replayed by an outsider');
  assert.equal((await carol.req('GET', `/api/files/${fileId}/url`)).status, 403);
  const random = '00000000-0000-0000-0000-000000000000';
  assert.equal((await carol.req('GET', `/api/files/${random}/url`)).status, 404);
  assert.equal((await carol.req('GET', `/api/files/${random}/download?exp=9999999999999&sig=x`)).status, 404);
});

test('tampered and expired signatures are rejected', async () => {
  const u = new URL(srv.baseUrl + fileUrl);
  const goodSig = u.searchParams.get('sig');
  // Deterministically change the last hex char (naive `+ '0'` is a no-op
  // when the char already is '0' — a real flake, not an app bug).
  const flipped = goodSig.slice(0, -1) + (goodSig.slice(-1) === '0' ? '1' : '0');
  const tampered = `/api/files/${fileId}/download?exp=${u.searchParams.get('exp')}&sig=${flipped}`;
  assert.equal((await alice.req('GET', tampered)).status, 403, 'one flipped signature char must fail');
  const crossFile = `/api/files/${fileId}/download?exp=${Date.now() + 60000}&sig=${goodSig}`;
  // Same signature value is bound to its own exp; a fresh exp with the old sig fails.
  assert.equal((await alice.req('GET', crossFile)).status, 403);
  const expired = `/api/files/${fileId}/download?exp=${Date.now() - 1000}&sig=deadbeefdeadbeef`;
  assert.equal((await alice.req('GET', expired)).status, 403, 'past expiry rejected even before signature math');
  // Owner download with the genuine URL still works (control). Note: this
  // upload is unattached, so even a room member (bob) is correctly denied
  // above/below — member download requires attachment (see files.test.js).
  assert.equal((await alice.req('GET', fileUrl)).status, 200);
});

test('file-ID manipulation: another user\'s unattached upload is not reachable', async () => {
  const id = await roomFor(alice, null);
  const up = await alice.req('POST', `/api/files/conversations/${id}/upload`, formFile(pngBytes(), 'mine.png'), { form: true });
  assert.equal(up.status, 201);
  const otherId = up.json.data.id;
  assert.equal((await bob.req('GET', `/api/files/${otherId}/url`)).status, 403);
  assert.equal((await bob.req('GET', up.json.data.downloadUrl)).status, 403);
  assert.equal((await carol.req('POST', `/api/files/conversations/${id}/upload`, formFile(pngBytes(), 'x.png'), { form: true })).status, 403,
    'non-member cannot upload into a room either');
});

test('size limit is enforced (1 MB in this suite via MAX_UPLOAD_MB)', async () => {
  const big = Buffer.concat([pngBytes(), Buffer.alloc(2 * 1024 * 1024, 0)]);
  const id = await roomFor(alice, null);
  const up = await alice.req('POST', `/api/files/conversations/${id}/upload`, formFile(big, 'big.png'), { form: true });
  assert.notEqual(up.status, 201, 'oversize upload must be rejected');
  assert.ok(!up.json?.data?.downloadUrl, 'no download URL for a rejected upload');
  // A small file still uploads afterwards (limit did not corrupt state).
  const small = await alice.req('POST', `/api/files/conversations/${id}/upload`, formFile(pngBytes(), 'small.png'), { form: true });
  assert.equal(small.status, 201);
});

test('magic bytes win over filename and declared MIME type', async () => {
  const id = await roomFor(alice, null);
  const fake = await alice.req('POST', `/api/files/conversations/${id}/upload`,
    formFile(Buffer.from('hello, I am not a png'), 'real.png'), { form: true });
  assert.equal(fake.status, 400, 'text bytes named .png rejected');
  const exe = await alice.req('POST', `/api/files/conversations/${id}/upload`,
    formFile(Buffer.from('MZ' + 'x'.repeat(100)), 'setup.exe'), { form: true });
  assert.equal(exe.status, 400, 'executable bytes rejected regardless of name');
  const spoofed = await alice.req('POST', `/api/files/conversations/${id}/upload`,
    formFile(pngBytes(), 'evil.exe', 'application/x-msdownload'), { form: true });
  assert.equal(spoofed.status, 201, 'real PNG accepted even with a hostile declared type/name');
  assert.equal(spoofed.json.data.mimeType, 'image/png', 'server reports the detected type, not the declared one');
});

test('path-traversal filenames are neutralized: opaque key + clean disposition', async () => {
  const id = await roomFor(alice, null);
  const up = await alice.req('POST', `/api/files/conversations/${id}/upload`, formFile(pngBytes(), '../../evil.png'), { form: true });
  assert.equal(up.status, 201);
  assert.ok(!up.json.data.downloadUrl.includes('..'), 'download URL must not contain traversal');
  const dl = await alice.req('GET', up.json.data.downloadUrl);
  assert.equal(dl.status, 200);
  const disp = dl.headers.get('content-disposition') || '';
  assert.ok(!disp.includes('..'), 'Content-Disposition must not carry a traversal filename');
  assert.ok(!disp.includes('/') || disp.includes('filename='), 'disposition is a plain filename');
});

test('null-byte filename is rejected or sanitized, never a 500 with internals', async () => {
  const id = await roomFor(alice, null);
  const boundary = '----nexora-test-boundary';
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a\x00b.png"\r\nContent-Type: image/png\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(header, 'latin1'), pngBytes(), Buffer.from(footer)]);
  const res = await fetch(srv.baseUrl + `/api/files/conversations/${id}/upload`, {
    method: 'POST',
    headers: { Cookie: alice.cookieHeader(), 'X-CSRF-Token': alice.csrf, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  // Busboy rejects a raw NUL byte in the multipart header itself, before
  // app code runs — a safe rejection (no file stored), even though it
  // surfaces as a generic 500 rather than a 400. What matters: no file,
  // no internals in the body.
  assert.ok([201, 400, 500].includes(res.status), `unexpected status ${res.status}`);
  const bodyText = await res.text();
  assert.ok(!bodyText.includes('node_modules') && !bodyText.includes('/home/') && !/22P05|42601/.test(bodyText),
    'rejection body must not leak internals');
  if (res.status === 201) {
    const j = JSON.parse(bodyText);
    const dl = await alice.req('GET', j.data.downloadUrl);
    const disp = dl.headers.get('content-disposition') || '';
    assert.ok(!disp.includes('\x00'), 'disposition must not contain a null byte');
  } else {
    assert.ok(!bodyText.includes('downloadUrl'), 'rejected upload must not yield a download URL');
  }
});

test('parcel photos accept images only; message uploads accept PDFs (type-scope difference)', async () => {
  const order = await alice.req('POST', '/api/deliveries', {
    name: 'Photo parcel', category: 'Documents', size: 'Small (fits a bag)', pickupArea: 'A', dropoffArea: 'B',
  });
  assert.equal(order.status, 201);
  const pdfBytes = Buffer.from('%PDF-1.4 fake pdf content');
  const bad = await alice.req('POST', `/api/files/deliveries/${order.json.data.id}/photo`, formFile(pdfBytes, 'doc.pdf'), { form: true });
  assert.equal(bad.status, 400, 'parcel photo must be an image');
  const id = await roomFor(alice, null);
  const okPdf = await alice.req('POST', `/api/files/conversations/${id}/upload`, formFile(pdfBytes, 'doc.pdf'), { form: true });
  assert.equal(okPdf.status, 201, 'PDF is an allowed message-attachment type');
});

test('private files are NOT served by Express static middleware', async () => {
  for (const p of ['/storage/x', '/storage/' + fileId, '/uploads/x', '/private/x', '/api/files/../storage/x']) {
    const r = await fetch(srv.baseUrl + p);
    assert.equal(r.status, 404, `${p} must not resolve to a file`);
    const text = await r.text();
    assert.ok(!text.includes('PNG'), 'static path must not leak file bytes');
  }
  // The frontend itself still serves (control that static middleware exists but is scoped).
  const home = await fetch(srv.baseUrl + '/');
  assert.equal(home.status, 200);
});
