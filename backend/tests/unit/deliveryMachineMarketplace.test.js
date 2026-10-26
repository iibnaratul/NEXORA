// Marketplace fulfilment transitions (deliveryMachine.js, fulfillment =
// 'marketplace') plus a regression lock on the courier path: the marketplace
// path must not leak into courier transitions or vice versa, and the old
// 3-argument call signature must keep meaning 'courier'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, transitionNeedsCode, isTerminal } from '../../src/services/deliveryMachine.js';

test('marketplace happy path is allowed step by step, seller only', () => {
  const path = [
    ['CREATED', 'PREPARED', 'sender'],
    ['PREPARED', 'READY_FOR_PICKUP', 'sender'],
    ['READY_FOR_PICKUP', 'DELIVERED', 'sender'],
  ];
  for (const [from, to, role] of path) {
    assert.equal(canTransition(from, to, role, 'marketplace'), true, `${from} -> ${to}`);
  }
});

test('marketplace transitions reject the buyer, the courier, and skips', () => {
  assert.equal(canTransition('CREATED', 'PREPARED', 'recipient', 'marketplace'), false, 'buyer never drives transitions');
  assert.equal(canTransition('CREATED', 'PREPARED', 'courier', 'marketplace'), false);
  assert.equal(canTransition('PREPARED', 'READY_FOR_PICKUP', 'recipient', 'marketplace'), false);
  assert.equal(canTransition('READY_FOR_PICKUP', 'DELIVERED', 'recipient', 'marketplace'), false);
  assert.equal(canTransition('CREATED', 'READY_FOR_PICKUP', 'sender', 'marketplace'), false, 'no skipping prepare');
  assert.equal(canTransition('CREATED', 'DELIVERED', 'sender', 'marketplace'), false);
  assert.equal(canTransition('PREPARED', 'DELIVERED', 'sender', 'marketplace'), false);
  assert.equal(canTransition('DELIVERED', 'READY_FOR_PICKUP', 'sender', 'marketplace'), false, 'terminal');
  assert.equal(canTransition('CANCELLED', 'PREPARED', 'sender', 'marketplace'), false, 'terminal');
});

test('marketplace handover needs the pickup code; other steps need none', () => {
  assert.equal(transitionNeedsCode('READY_FOR_PICKUP', 'DELIVERED', 'marketplace'), 'pickup');
  assert.equal(transitionNeedsCode('CREATED', 'PREPARED', 'marketplace'), null);
  assert.equal(transitionNeedsCode('PREPARED', 'READY_FOR_PICKUP', 'marketplace'), null);
});

test('marketplace cancellation: sender/admin from pre-pickup states only', () => {
  for (const from of ['CREATED', 'PREPARED', 'READY_FOR_PICKUP']) {
    assert.equal(canTransition(from, 'CANCELLED', 'sender', 'marketplace'), true, from);
    assert.equal(canTransition(from, 'CANCELLED', 'admin', 'marketplace'), true, from);
    assert.equal(canTransition(from, 'CANCELLED', 'recipient', 'marketplace'), false, from);
    assert.equal(canTransition(from, 'CANCELLED', 'courier', 'marketplace'), false, from);
  }
  for (const from of ['DELIVERED', 'CANCELLED']) {
    assert.equal(canTransition(from, 'CANCELLED', 'sender', 'marketplace'), false, from);
  }
  // Marketplace states are not cancellable on the courier path and vice versa.
  assert.equal(canTransition('PREPARED', 'CANCELLED', 'sender'), false, 'courier path knows no PREPARED');
  assert.equal(canTransition('SEARCHING_FOR_COURIER', 'CANCELLED', 'sender', 'marketplace'), false);
});

test('paths never cross: marketplace states are illegal for courier and reverse', () => {
  assert.equal(canTransition('CREATED', 'PREPARED', 'sender'), false, 'default (courier) fulfillment');
  assert.equal(canTransition('CREATED', 'PREPARED', 'sender', 'courier'), false);
  assert.equal(canTransition('CREATED', 'SEARCHING_FOR_COURIER', 'sender', 'marketplace'), false);
  assert.equal(canTransition('ACCEPTED', 'PICKUP_VERIFIED', 'sender', 'marketplace'), false);
  assert.equal(canTransition('READY_FOR_PICKUP', 'DELIVERED', 'courier', 'marketplace'), false);
});

test('courier transitions unchanged (regression lock, old signature = courier)', () => {
  const path = [
    ['CREATED', 'SEARCHING_FOR_COURIER', 'sender'],
    ['SEARCHING_FOR_COURIER', 'ASSIGNED', 'courier'],
    ['ASSIGNED', 'ACCEPTED', 'courier'],
    ['ACCEPTED', 'PICKUP_VERIFIED', 'courier'],
    ['PICKUP_VERIFIED', 'IN_TRANSIT', 'courier'],
    ['IN_TRANSIT', 'DROPOFF_VERIFIED', 'courier'],
    ['DROPOFF_VERIFIED', 'DELIVERED', 'courier'],
  ];
  for (const [from, to, role] of path) assert.equal(canTransition(from, to, role), true, `${from} -> ${to}`);
  assert.equal(transitionNeedsCode('ACCEPTED', 'PICKUP_VERIFIED'), 'pickup');
  assert.equal(transitionNeedsCode('IN_TRANSIT', 'DROPOFF_VERIFIED'), 'dropoff');
  assert.equal(transitionNeedsCode('DROPOFF_VERIFIED', 'DELIVERED'), null);
  for (const from of ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED']) {
    assert.equal(canTransition(from, 'CANCELLED', 'sender'), true, from);
  }
  assert.equal(canTransition('PICKUP_VERIFIED', 'CANCELLED', 'sender'), false);
});

test('terminal states include the marketplace terminals, not the intermediates', () => {
  assert.equal(isTerminal('DELIVERED'), true);
  assert.equal(isTerminal('CANCELLED'), true);
  assert.equal(isTerminal('PREPARED'), false);
  assert.equal(isTerminal('READY_FOR_PICKUP'), false);
  assert.equal(isTerminal('CREATED'), false);
});
