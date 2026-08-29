import { jidDecode, jidNormalizedUser } from '@whiskeysockets/baileys';
import { getDatabase } from '../database/connection.js';
import type { User } from '../database/types.js';
import { config } from '../config.js';
import { UnauthorizedError } from '../router/errors.js';

export interface NormalizedJidInfo {
  jid: string;
  user: string;
  server: string;
  isLid: boolean;
  phoneNumber: string;
}

// In-memory registry of dynamic admin identifiers discovered via WhatsApp USync
const recognizedAdminLids = new Set<string>();

/**
 * Registers an admin LID discovered dynamically via Baileys USync (onWhatsApp)
 * or via inbound message handshake.
 */
export function registerAdminLid(lid: string): void {
  const norm = normalizeJid(lid);
  recognizedAdminLids.add(norm.jid);
  recognizedAdminLids.add(norm.user);

  // If a user row exists in SQLite for this LID (e.g. was previously inserted as unauthorized),
  // immediately update it to authorized (1)
  try {
    const db = getDatabase();
    const now = Date.now();
    db.prepare('UPDATE users SET is_authorized = 1, updated_at = ? WHERE id = ?').run(
      now,
      norm.jid
    );
  } catch {
    // Database might not be initialized yet in early lifecycle or tests
  }
}

export function getRecognizedAdminLids(): string[] {
  return Array.from(recognizedAdminLids);
}

export function clearAdminLids(): void {
  recognizedAdminLids.clear();
}

/**
 * Normalizes any WhatsApp JID (phone, device suffix, or LID)
 * using Baileys canonical protobuf decoder.
 */
export function normalizeJid(jid: string): NormalizedJidInfo {
  const decoded = jidDecode(jid);
  if (!decoded) {
    const cleaned = jid.replace(/:.*@/, '@');
    const user = cleaned.split('@')[0].replace(/\D/g, '');
    const server = cleaned.split('@')[1] || 's.whatsapp.net';
    return {
      jid: cleaned,
      user,
      server,
      isLid: server === 'lid',
      phoneNumber: user,
    };
  }

  const normalized = jidNormalizedUser(jid);
  return {
    jid: normalized,
    user: decoded.user,
    server: decoded.server,
    isLid: decoded.server === 'lid',
    phoneNumber: decoded.user,
  };
}

/**
 * Checks whether a sender JID belongs to the configured administrator:
 * 1. Matches configured ADMIN_PHONE_NUMBER on @s.whatsapp.net or @c.us
 * 2. Matches optional static ADMIN_LID in configuration
 * 3. Matches dynamically discovered admin LID from Baileys USync
 */
export function isSenderAdmin(senderJid: string): boolean {
  const norm = normalizeJid(senderJid);

  // 1. Phone number match for standard phone JIDs (@s.whatsapp.net, @c.us)
  if (!norm.isLid) {
    if (norm.user === config.ADMIN_PHONE_NUMBER) {
      return true;
    }
  }

  // 2. Configured static ADMIN_LID in environment (if specified)
  if (config.ADMIN_LID) {
    const staticNorm = normalizeJid(config.ADMIN_LID);
    if (norm.jid === staticNorm.jid || norm.user === staticNorm.user) {
      return true;
    }
  }

  // 3. Dynamically registered admin LID(s) discovered from Baileys USync (onWhatsApp)
  if (norm.isLid) {
    if (recognizedAdminLids.has(norm.jid) || recognizedAdminLids.has(norm.user)) {
      return true;
    }
  }

  return false;
}

export function authorizeUser(senderJid: string, pushName?: string): User {
  const norm = normalizeJid(senderJid);
  const jid = norm.jid;
  const phoneNumber = norm.phoneNumber;
  const db = getDatabase();

  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(jid) as User | undefined;

  const isAdmin = isSenderAdmin(senderJid);
  const now = Date.now();

  if (!user) {
    // If sender is admin phone number or recognized admin LID, auto-whitelist
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
