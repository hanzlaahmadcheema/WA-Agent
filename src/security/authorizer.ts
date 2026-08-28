import { getDatabase } from '../database/connection.js';
import type { User } from '../database/types.js';
import { config } from '../config.js';
import { UnauthorizedError } from '../router/errors.js';

export function normalizeJid(jid: string): { jid: string; phoneNumber: string } {
  // Strip any WhatsApp device suffix: e.g. 1234567890:12@s.whatsapp.net -> 1234567890@s.whatsapp.net
  const cleaned = jid.replace(/:.*@/, '@');
  const phoneNumber = cleaned.split('@')[0].replace(/\D/g, '');
  return { jid: cleaned, phoneNumber };
}

export function authorizeUser(senderJid: string, pushName?: string): User {
  const { jid, phoneNumber } = normalizeJid(senderJid);
  const db = getDatabase();

  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(jid) as User | undefined;

  const isAdmin = phoneNumber === config.ADMIN_PHONE_NUMBER;
  const now = Date.now();

  if (!user) {
    // If sender is admin phone number, auto-whitelist
    const isAuthorized = isAdmin ? 1 : 0;
    db.prepare(`
      INSERT INTO users (id, phone_number, display_name, is_authorized, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(jid, phoneNumber, pushName || null, isAuthorized, now, now);

    if (!isAuthorized) {
      throw new UnauthorizedError();
    }

    return {
      id: jid,
      phone_number: phoneNumber,
      display_name: pushName || null,
      is_authorized: 1,
      created_at: now,
      updated_at: now,
    };
  }

  if (isAdmin && !user.is_authorized) {
    db.prepare('UPDATE users SET is_authorized = 1, updated_at = ? WHERE id = ?').run(
      now,
      jid
    );
    user.is_authorized = 1;
  }

  if (!user.is_authorized) {
    throw new UnauthorizedError();
  }

  return user;
}
