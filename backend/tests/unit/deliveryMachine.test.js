import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, transitionNeedsCode, isTerminal } from '../../src/services/deliveryMachine.js';

test('full happy path is allowed step by step', () => {
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
});

test('invalid transitions are rejected, even for a modified client', () => {
  assert.equal(canTransition('CREATED', 'DELIVERED', 'courier'), false);
  assert.equal(canTransition('CREATED', 'PICKUP_VERIFIED', 'courier'), false);
  assert.equal(canTransition('DELIVERED', 'IN_TRANSIT', 'courier'), false);
  assert.equal(canTransition('CANCELLED', 'SEARCHING_FOR_COURIER', 'sender'), false);
  assert.equal(canTransition('ACCEPTED', 'DELIVERED', 'courier'), false);
  assert.equal(canTransition('IN_TRANSIT', 'DELIVERED', 'sender'), false);
});

test('wrong roles cannot transition', () => {
  assert.equal(canTransition('ASSIGNED', 'ACCEPTED', 'sender'), false);
  assert.equal(canTransition('ACCEPTED', 'PICKUP_VERIFIED', 'sender'), false);
  assert.equal(canTransition('CREATED', 'SEARCHING_FOR_COURIER', 'courier'), false);
});

test('cancellation rules', () => {
  for (const from of ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED']) {
    assert.equal(canTransition(from, 'CANCELLED', 'sender'), true, from);
    assert.equal(canTransition(from, 'CANCELLED', 'courier'), false, from);
  }
  for (const from of ['PICKUP_VERIFIED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED']) {
    assert.equal(canTransition(from, 'CANCELLED', 'sender'), false, from);
  }
});

test('code requirements are attached to the right steps', () => {
  assert.equal(transitionNeedsCode('ACCEPTED', 'PICKUP_VERIFIED'), 'pickup');
  assert.equal(transitionNeedsCode('IN_TRANSIT', 'DROPOFF_VERIFIED'), 'dropoff');
  assert.equal(transitionNeedsCode('PICKUP_VERIFIED', 'IN_TRANSIT'), null);
  assert.equal(transitionNeedsCode('DROPOFF_VERIFIED', 'DELIVERED'), null);
});

test('terminal states', () => {
  assert.equal(isTerminal('DELIVERED'), true);
  assert.equal(isTerminal('CANCELLED'), true);
  assert.equal(isTerminal('IN_TRANSIT'), false);
});
