// NEXORA TRANSIT state machine. The server is the only authority: every
// transition is validated here, so a modified client cannot skip steps.
// Pure function — unit-tested without a database.
//
// Two fulfilment paths share the DELIVERED / CANCELLED terminals but never
// each other's intermediate states:
//   courier (default, unchanged): CREATED -> SEARCHING_FOR_COURIER ->
//     ASSIGNED -> ACCEPTED -> PICKUP_VERIFIED -> IN_TRANSIT ->
//     DROPOFF_VERIFIED -> DELIVERED
//   marketplace: CREATED -> PREPARED -> READY_FOR_PICKUP -> DELIVERED
//     (READY_FOR_PICKUP is reached only via the drop-off endpoint, which
//     additionally requires a pin; DELIVERED additionally requires the
//     one-time 'pickup' code verified by the handover endpoint.)
// canTransition()/transitionNeedsCode() keep their old 3-argument call
// signature: fulfillment defaults to 'courier', so existing callers and
// unit tests are unaffected.
export const DELIVERY_STATES = [
  'CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED', 'PICKUP_VERIFIED',
  'IN_TRANSIT', 'DROPOFF_VERIFIED', 'DELIVERED', 'CANCELLED',
  'PREPARED', 'READY_FOR_PICKUP',
];

// allowed[from] = [{ to, by: ['sender'|'courier'|'admin'], needsCode: 'pickup'|'dropoff'|null }]
export const TRANSITIONS = {
  CREATED: [{ to: 'SEARCHING_FOR_COURIER', by: ['sender', 'admin'] }],
  SEARCHING_FOR_COURIER: [{ to: 'ASSIGNED', by: ['courier'] }], // via atomic claim, not this table alone
  ASSIGNED: [{ to: 'ACCEPTED', by: ['courier'] }],
  ACCEPTED: [{ to: 'PICKUP_VERIFIED', by: ['courier'], needsCode: 'pickup' }],
  PICKUP_VERIFIED: [{ to: 'IN_TRANSIT', by: ['courier'] }],
  IN_TRANSIT: [{ to: 'DROPOFF_VERIFIED', by: ['courier'], needsCode: 'dropoff' }],
  DROPOFF_VERIFIED: [{ to: 'DELIVERED', by: ['courier'] }],
  DELIVERED: [],
  CANCELLED: [],
};

// Marketplace path. 'sender' here is the seller; the buyer is the
// 'recipient' participant and may never drive these transitions (the
// buyer-only step is /arrive, which changes no state).
export const MARKETPLACE_TRANSITIONS = {
  CREATED: [{ to: 'PREPARED', by: ['sender'] }],
  PREPARED: [{ to: 'READY_FOR_PICKUP', by: ['sender'] }],
  READY_FOR_PICKUP: [{ to: 'DELIVERED', by: ['sender'], needsCode: 'pickup' }],
  DELIVERED: [],
  CANCELLED: [],
};

const CANCELLABLE_FROM = ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED'];
const MARKETPLACE_CANCELLABLE_FROM = ['CREATED', 'PREPARED', 'READY_FOR_PICKUP'];

export function canTransition(from, to, actorRole, fulfillment = 'courier') {
  if (to === 'CANCELLED') {
    if (fulfillment === 'marketplace') {
      return MARKETPLACE_CANCELLABLE_FROM.includes(from) && ['sender', 'admin'].includes(actorRole);
    }
    return CANCELLABLE_FROM.includes(from) && ['sender', 'admin'].includes(actorRole);
  }
  const table = fulfillment === 'marketplace' ? MARKETPLACE_TRANSITIONS : TRANSITIONS;
  const rule = (table[from] || []).find((r) => r.to === to);
  if (!rule) return false;
  return rule.by.includes(actorRole);
}

export function transitionNeedsCode(from, to, fulfillment = 'courier') {
  const table = fulfillment === 'marketplace' ? MARKETPLACE_TRANSITIONS : TRANSITIONS;
  const rule = (table[from] || []).find((r) => r.to === to);
  return rule ? rule.needsCode || null : null;
}

export function isTerminal(status) {
  return status === 'DELIVERED' || status === 'CANCELLED';
}
