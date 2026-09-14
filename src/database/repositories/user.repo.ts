import { getDatabase } from '../connection.js';
import type { User } from '../types.js';

export function getUserById(id: string): User | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User | undefined;
}

export function getUserByPhone(phoneNumber: string): User | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM users WHERE phone_number = ?').get(phoneNumber) as unknown as User | undefined;
}

export function upsertUser(
  id: string,
  phoneNumber: string,
  displayName: string | null = null,
  isAuthorized: number = 0
): User {
  const db = getDatabase();
  const now = Date.now();

  db.prepare(`
    INSERT INTO users (id, phone_number, display_name, is_authorized, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      phone_number = excluded.phone_number,
      display_name = COALESCE(excluded.display_name, users.display_name),
      is_authorized = excluded.is_authorized,
      updated_at = excluded.updated_at
  `).run(id, phoneNumber, displayName, isAuthorized, now, now);

  return getUserById(id)!;
}

export function authorizeUserByIdOrPhone(identifier: string): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare('UPDATE users SET is_authorized = 1, updated_at = ? WHERE id = ? OR phone_number = ?').run(
    now,
    identifier,
    identifier
  );
}
