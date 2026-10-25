import test from 'node:test';
import assert from 'node:assert/strict';
import { newCode, encryptCode, decryptCode, codesEqual, newNexoraId, newPublicRef, sha256 } from '../../src/utils/helpers.js';
import { detectMime } from '../../src/middleware/upload.js';
import { schemas, validate } from '../../src/validation/schemas.js';

test('NEXORA IDs match the server format', () => {
  for (let i = 0; i < 50; i++) {
    assert.match(newNexoraId(), /^NXR-[2-9A-HJ-NP-Z]{8}$/);
  }
  const ids = new Set(Array.from({ length: 1000 }, () => newNexoraId()));
  assert.equal(ids.size, 1000, 'IDs must be unique in practice');
});

test('handover codes are 6 digits and encrypt/decrypt round-trips', () => {
  const code = newCode();
  assert.match(code, /^\d{6}$/);
  const enc = encryptCode(code);
  assert.notEqual(enc, code, 'code must never be stored in plaintext form');
  assert.equal(decryptCode(enc), code);
  // Same code encrypts differently each time (random IV).
  assert.notEqual(encryptCode(code), enc);
});

test('code comparison is exact', () => {
  assert.equal(codesEqual('123456', '123456'), true);
  assert.equal(codesEqual('123456', '123457'), false);
  assert.equal(codesEqual('123456', '12345'), false);
});

test('sha256 is deterministic', () => {
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
});

test('public refs match format', () => {
  assert.match(newPublicRef(), /^NXD-[2-9A-HJ-NP-Z]{6}$/);
});

test('magic-byte detection trusts bytes, not names', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal(detectMime(png), 'image/png');
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(detectMime(jpg), 'image/jpeg');
  const fakePng = Buffer.from('This is not a PNG file at all, just text.');
  assert.equal(detectMime(fakePng), null, 'text renamed to .png must be rejected');
  const pdf = Buffer.from('%PDF-1.7 fake content');
  assert.equal(detectMime(pdf), 'application/pdf');
  assert.equal(detectMime(Buffer.alloc(0)), null);
});

test('validation rejects bad delivery input', () => {
  assert.throws(() => validate(schemas.createDelivery, {
    name: '', category: 'Documents', size: 'Small (fits a bag)', pickupArea: 'A', dropoffArea: 'B',
  }), /name/);
  assert.throws(() => validate(schemas.createDelivery, {
    name: 'x', category: 'Spaceship', size: 'Small (fits a bag)', pickupArea: 'A', dropoffArea: 'B',
  }));
  assert.throws(() => validate(schemas.createDelivery, {
    name: 'x', category: 'Documents', size: 'Small (fits a bag)', pickupArea: 'A', dropoffArea: 'B', pickupLat: 200,
  }));
  const good = validate(schemas.createDelivery, {
    name: 'Parcel', category: 'Documents', size: 'Small (fits a bag)', pickupArea: 'Savar', dropoffArea: 'Dhanmondi',
  });
  assert.equal(good.name, 'Parcel');
});

test('validation rejects bad messages and conversations', () => {
  assert.throws(() => validate(schemas.sendMessage, { body: '' }));
  assert.throws(() => validate(schemas.sendMessage, { body: 'x'.repeat(2001) }));
  assert.throws(() => validate(schemas.createConversation, { type: 'dm', memberNexoraIds: [] }));
  assert.throws(() => validate(schemas.createConversation, { type: 'dm', memberNexoraIds: ['NXR-AAAAAAAA', 'NXR-BBBBBBBB'] }));
  assert.throws(() => validate(schemas.verifyCode, { stage: 'pickup', code: '12345' }));
  assert.throws(() => validate(schemas.verifyCode, { stage: 'pickup', code: 'abcdef' }));
});
