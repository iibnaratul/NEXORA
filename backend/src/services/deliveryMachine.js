// NEXORA TRANSIT state machine. The server is the only authority: every
// transition is validated here, so a modified client cannot skip steps.
// Pure function — unit-tested without a database.
export const DELIVERY_STATES = [
  'CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED', 'PICKUP_VERIFIED',
  'IN_TRANSIT', 'DROPOFF_VERIFIED', 'DELIVERED', 'CANCELLED',
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

const CANCELLABLE_FROM = ['CREATED', 'SEARCHING_FOR_COURIER', 'ASSIGNED', 'ACCEPTED'];

export function canTransition(from, to, actorRole) {
  if (to === 'CANCELLED') {
    return CANCELLABLE_FROM.includes(from) && ['sender', 'admin'].includes(actorRole);
  }
  const rule = (TRANSITIONS[from] || []).find((r) => r.to === to);
  if (!rule) return false;
  return rule.by.includes(actorRole);
}

export function transitionNeedsCode(from, to) {
  const rule = (TRANSITIONS[from] || []).find((r) => r.to === to);
  return rule ? rule.needsCode || null : null;
}

export function isTerminal(status) {
  return status === 'DELIVERED' || status === 'CANCELLED';
}
