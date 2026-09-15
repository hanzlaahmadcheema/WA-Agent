/**
 * reminder-repo.ts
 * SQLite-backed CRUD for reminders.
 * Uses the existing shared DB connection — no additional deps.
 */

import { getDatabase } from '../database/connection.js';

export interface Reminder {
  id: number;
  user_id: string;       // WhatsApp JID
  message: string;
  fire_at: number;       // Epoch ms
  status: 'pending' | 'fired' | 'cancelled';
  snoozed_count: number;
  created_at: number;
}

// ─── Schema bootstrap ──────────────────────────────────────────────────────────
// Called once at startup to ensure the table exists (additive migration).
export function ensureRemindersTable(): void {
  const db = getDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      message      TEXT    NOT NULL,
      fire_at      INTEGER NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      snoozed_count INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_user_status
      ON reminders(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_reminders_fire_at
      ON reminders(fire_at) WHERE status = 'pending';
  `);
}

// ─── Write ─────────────────────────────────────────────────────────────────────

export function createReminder(userId: string, message: string, fireAt: Date): Reminder {
  const db = getDatabase();
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO reminders (user_id, message, fire_at, status, snoozed_count, created_at)
       VALUES (?, ?, ?, 'pending', 0, ?)`
    )
    .run(userId, message, fireAt.getTime(), now);

  return {
    id: result.lastInsertRowid as number,
    user_id: userId,
    message,
    fire_at: fireAt.getTime(),
    status: 'pending',
    snoozed_count: 0,
    created_at: now,
  };
}

export function cancelReminder(id: number, userId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending'`)
    .run(id, userId);
  return (result.changes as number) > 0;
}

export function snoozeReminder(id: number, userId: string, snoozeMs: number): boolean {
  const db = getDatabase();
  const newFireAt = Date.now() + snoozeMs;
  const result = db
    .prepare(
      `UPDATE reminders
       SET fire_at = ?, snoozed_count = snoozed_count + 1
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(newFireAt, id, userId);
  return (result.changes as number) > 0;
}

export function markFired(id: number): void {
  const db = getDatabase();
  db.prepare(`UPDATE reminders SET status = 'fired' WHERE id = ?`).run(id);
}

// ─── Read ──────────────────────────────────────────────────────────────────────

export function listPendingReminders(userId: string): Reminder[] {
  const db = getDatabase();
  return db
    .prepare(`SELECT * FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY fire_at ASC`)
    .all(userId) as unknown as Reminder[];
}

/** Returns all reminders due right now across all users. */
export function getDueReminders(): Reminder[] {
  const db = getDatabase();
  return db
    .prepare(`SELECT * FROM reminders WHERE status = 'pending' AND fire_at <= ?`)
    .all(Date.now()) as unknown as Reminder[];
}
