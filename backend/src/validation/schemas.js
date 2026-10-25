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
