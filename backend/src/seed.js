// Development/test seed ONLY. Refuses to run in production.
// Creates: an admin, two demo users, a public room, and one queued delivery.
// Demo passwords are documented in README and must be changed immediately.
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { query, closePool } from './db.js';
import { config } from './config.js';
import { newNexoraId } from './utils/helpers.js';

if (config.env === 'production') {
  console.error('[seed] Refusing to seed in production.');
  process.exit(1);
}

async function makeUser({ email, password, displayName, role = 'user', anonymous = false }) {
  const hash = password ? await bcrypt.hash(password, 4) : null;
  const id = randomUUID();
  const { rows } = await query(
    `INSERT INTO users (id, nexora_id, email, password_hash, role, is_anonymous, display_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [id, newNexoraId(), email || null, hash, role, anonymous, displayName],
  );
  await query('INSERT INTO public_profiles (user_id, display_name) VALUES ($1, $2)', [id, displayName]);
  return rows[0];
}

const admin = await makeUser({ email: 'admin@nexora.local', password: 'Admin123!change', displayName: 'NEXORA Admin', role: 'admin' });
const alice = await makeUser({ email: 'alice@nexora.local', password: 'Alice123!change', displayName: 'Alice' });
const bob = await makeUser({ email: 'bob@nexora.local', password: 'Bob123!change', displayName: 'Bob' });
await query('INSERT INTO courier_profiles (user_id, available) VALUES ($1, TRUE)', [bob.id]);
await query("UPDATE users SET role = 'courier' WHERE id = $1", [bob.id]);

const roomId = randomUUID();
await query('INSERT INTO conversations (id, type, name, description, created_by) VALUES ($1, \'room\', \'Lounge\', \'Public room for everyone\', $2)',
  [roomId, admin.id]);
await query('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, \'owner\'), ($1, $3, \'member\')',
  [roomId, admin.id, alice.id]);

const deliveryId = randomUUID();
await query(
  `INSERT INTO deliveries (id, public_ref, sender_id, name, category, size, pickup_area, dropoff_area, status)
   VALUES ($1, 'NXD-SEED001', $2, 'Demo parcel', 'Documents', 'Small (fits a bag)', 'Savar Bazar', 'Dhanmondi', 'SEARCHING_FOR_COURIER')`,
  [deliveryId, alice.id],
);
await query('INSERT INTO delivery_participants (delivery_id, user_id, role) VALUES ($1, $2, \'sender\')', [deliveryId, alice.id]);

console.log('[seed] done');
console.log('  admin:', admin.nexora_id, 'admin@nexora.local / Admin123!change');
console.log('  alice:', alice.nexora_id, 'alice@nexora.local / Alice123!change');
console.log('  bob (courier):', bob.nexora_id, 'bob@nexora.local / Bob123!change');
await closePool();
