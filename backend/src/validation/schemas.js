// Server-side validation for every write operation (Zod). The client is never
// trusted: maxlengths, enums, ranges and formats are enforced here, and the
// database constraints in 001_init.sql are a second layer.
import { z } from 'zod';

const displayName = z.string().trim().max(24).optional().default('');
const avatarGlyph = z.string().trim().max(10).optional().default('◈');
const uuid = z.string().uuid();
const nexoraId = z.string().regex(/^NXR-[2-9A-HJ-NP-Z]{8}$/);

export const schemas = {
  anonymous: z.object({ displayName, avatarGlyph }),
  register: z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10).max(200),
    displayName, avatarGlyph,
  }),
  login: z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(200),
  }),
  claim: z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(10).max(200),
  }),
  updateMe: z.object({
    displayName: z.string().trim().max(24).optional(),
    avatarGlyph: z.string().trim().max(10).optional(),
    bio: z.string().trim().max(300).optional(),
  }).refine((o) => Object.keys(o).length > 0, 'Nothing to update'),
  createConversation: z.object({
    type: z.enum(['dm', 'group', 'room']),
    name: z.string().trim().max(40).optional(),
    description: z.string().trim().max(120).optional().default(''),
    // For dm: exactly one other member. For group: 0+ members. For room: ignored.
    memberNexoraIds: z.array(nexoraId).max(200).optional().default([]),
  }).superRefine((o, ctx) => {
    if (o.type === 'dm' && o.memberNexoraIds.length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'A DM needs exactly one other member' });
    }
    if (o.type !== 'dm' && o.type !== 'room' && !o.name) {
      ctx.addIssue({ code: 'custom', message: 'Groups need a name' });
    }
    if (o.type === 'room' && !o.name) {
      ctx.addIssue({ code: 'custom', message: 'Rooms need a name' });
    }
  }),
  sendMessage: z.object({
    body: z.string().trim().min(1).max(2000),
    replyToId: uuid.optional().nullable(),
    clientId: z.string().max(100).optional(),
    attachmentIds: z.array(uuid).max(5).optional().default([]),
  }),
  editMessage: z.object({ body: z.string().trim().min(1).max(2000) }),
  addMember: z.object({ nexoraId }),
  createDelivery: z.object({
    name: z.string().trim().min(1).max(60),
    category: z.enum(['Documents', 'Small goods', 'Clothing', 'Electronics', 'Other']),
    size: z.enum(['Small (fits a bag)', 'Medium (box)', 'Large']),
    weightKg: z.number().min(0).max(1000).optional().default(0),
    pickupArea: z.string().trim().min(1).max(60),
    dropoffArea: z.string().trim().min(1).max(60),
    pickupLat: z.number().min(-90).max(90).optional().nullable(),
    pickupLng: z.number().min(-180).max(180).optional().nullable(),
    dropoffLat: z.number().min(-90).max(90).optional().nullable(),
    dropoffLng: z.number().min(-180).max(180).optional().nullable(),
    instructions: z.string().trim().max(300).optional().default(''),
    feeOffer: z.number().min(0).max(1_000_000).optional().default(0),
    fragile: z.boolean().optional().default(false),
    publish: z.boolean().optional().default(true),
  }),
  verifyCode: z.object({
    stage: z.enum(['pickup', 'dropoff']),
    code: z.string().regex(/^\d{6}$/),
  }),
  dispute: z.object({ reason: z.string().trim().min(1).max(500) }),
  // Marketplace delivery requests (Phase 1). Body keys are camelCase, as
  // elsewhere; price is integer minor units (BDT paisa-equivalent), nullable.
  createDeliveryRequest: z.object({
    conversationId: uuid,
    targetId: uuid,
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(1000),
    priceMinor: z.number().int().min(0).max(100_000_000).optional().nullable(),
    note: z.string().trim().max(500).optional().nullable(),
  }),
  updateDeliveryRequest: z.object({
    title: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().min(1).max(1000).optional(),
    priceMinor: z.number().int().min(0).max(100_000_000).optional().nullable(),
    note: z.string().trim().max(500).optional().nullable(),
  }).refine((o) => Object.keys(o).length > 0, 'Nothing to update'),
  deliverySettings: z.object({
    enabled: z.boolean().optional(),
    allowRequests: z.string().trim().min(1).max(40).optional(),
  }).refine((o) => Object.keys(o).length > 0, 'Nothing to update'),
  // Drop-off pin. Coordinates are user-supplied unless the caller explicitly
  // says they came from the one-shot GPS reading (dropoffCoordSource: 'gps');
  // a coarse area string is never turned into coordinates.
  dropoff: z.object({
    dropoffLat: z.number().min(-90).max(90),
    dropoffLng: z.number().min(-180).max(180),
    dropoffArea: z.string().trim().min(1).max(60).optional(),
    dropoffPhotoFileId: uuid.optional().nullable(),
    dropoffCoordSource: z.enum(['user-supplied', 'gps']).optional().default('user-supplied'),
  }),
  handover: z.object({ code: z.string().regex(/^\d{6}$/) }),
  // ---- 005: community hub / transaction flow / trust ----
  pinMessage: z.object({ messageId: uuid }),
  groupRules: z.object({ rules: z.string().trim().max(1000) }),
  transferOwnership: z.object({ newOwnerId: uuid, confirm: z.literal(true) }),
  memberRole: z.object({ role: z.enum(['admin', 'moderator', 'member']) }),
  createInvite: z.object({
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
    maxUses: z.number().int().min(1).max(10000).optional().nullable(),
  }),
  joinByCode: z.object({ code: z.string().trim().min(1).max(32) }),
  messageReaction: z.object({ emoji: z.string().trim().min(1).max(20) }),
  shareLocation: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  deliveryRating: z.object({
    stars: z.number().int().min(1).max(5),
    comment: z.string().trim().max(500).optional().nullable(),
  }),
  report: z.object({
    targetType: z.enum(['message', 'user', 'delivery']),
    targetId: uuid,
    reason: z.string().trim().min(1).max(500),
  }),
  block: z.object({ nexoraId }),
  setRole: z.object({ role: z.enum(['user', 'courier', 'admin']) }),
  setAvailability: z.object({ available: z.boolean(), vehicle: z.string().trim().max(60).optional().default('') }),
  transition: z.object({ to: z.string() }),
};

export function validate(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    const err = new Error(first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid input');
    err.status = 400; err.code = 'VALIDATION_ERROR';
    throw err;
  }
  return r.data;
}
