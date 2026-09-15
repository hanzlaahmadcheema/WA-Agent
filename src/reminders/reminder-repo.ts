/**
 * reminder-repo.ts
 * SQLite-backed CRUD for one-time and recurring reminders.
 * Uses the existing shared DB connection — no external dependencies.
 */

import { getDatabase } from '../database/connection.js';
import type { RecurrenceRule } from './reminder-parser.js';

export interface Reminder {
  id: number;
  user_id: string;                                           // WhatsApp JID
  message: string;
  fire_at: number;                                           // Epoch ms of next scheduled fire
  status: 'pending' | 'fired' | 'cancelled';
  snoozed_count: number;
  created_at: number;                                        // Epoch ms
  recurrence_type?: 'interval' | 'daily' | 'weekly' | 'monthly' | null;
  recurrence_rule?: string | null;                           // JSON stringified RecurrenceRule
  recurrence_interval_ms?: number | null;
  last_fired_at?: number | null;
}

// ─── Schema bootstrap ──────────────────────────────────────────────────────────

export function ensureRemindersTable(): void {
  const db = getDatabase();

  // Create baseline table
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminders (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id                TEXT    NOT NULL,
      message                TEXT    NOT NULL,
      fire_at                INTEGER NOT NULL,
      status                 TEXT    NOT NULL DEFAULT 'pending',
      snoozed_count          INTEGER NOT NULL DEFAULT 0,
      created_at             INTEGER NOT NULL,
      recurrence_type        TEXT,
      recurrence_rule        TEXT,
      recurrence_interval_ms INTEGER,
      last_fired_at          INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_user_status
      ON reminders(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_reminders_fire_at
      ON reminders(fire_at) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_reminders_status_fire_at
      ON reminders(status, fire_at);
  `);

  // Safe additive migrations for existing databases
  try { db.exec(`ALTER TABLE reminders ADD COLUMN recurrence_type TEXT;`); } catch { /* ignore if column exists */ }
  try { db.exec(`ALTER TABLE reminders ADD COLUMN recurrence_rule TEXT;`); } catch { /* ignore */ }
  try { db.exec(`ALTER TABLE reminders ADD COLUMN recurrence_interval_ms INTEGER;`); } catch { /* ignore */ }
  try { db.exec(`ALTER TABLE reminders ADD COLUMN last_fired_at INTEGER;`); } catch { /* ignore */ }
}

// ─── Write ─────────────────────────────────────────────────────────────────────

export function createReminder(
  userId: string,
  message: string,
  fireAt: Date,
  recurrence?: RecurrenceRule
): Reminder {
  const db = getDatabase();
  const now = Date.now();

  const recurrenceType = recurrence?.type || null;
  const recurrenceRuleStr = recurrence ? JSON.stringify(recurrence) : null;
  const recurrenceIntervalMs = recurrence?.intervalMs || null;

  const result = db
    .prepare(
      `INSERT INTO reminders (
        user_id, message, fire_at, status, snoozed_count, created_at,
        recurrence_type, recurrence_rule, recurrence_interval_ms, last_fired_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, NULL)`
    )
    .run(
      userId,
      message,
      fireAt.getTime(),
      now,
      recurrenceType,
      recurrenceRuleStr,
      recurrenceIntervalMs
    );

  const id = result.lastInsertRowid as number;

  return {
    id,
    user_id: userId,
    message,
    fire_at: fireAt.getTime(),
    status: 'pending',
    snoozed_count: 0,
    created_at: now,
    recurrence_type: recurrenceType,
    recurrence_rule: recurrenceRuleStr,
    recurrence_interval_ms: recurrenceIntervalMs,
    last_fired_at: null,
  };
}

export function advanceRecurringReminder(id: number, nextFireAtMs: number): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE reminders
     SET fire_at = ?, last_fired_at = ?, status = 'pending'
     WHERE id = ?`
  ).run(nextFireAtMs, Date.now(), id);
}

export function cancelReminder(id: number, userId: string): boolean {
  const db = getDatabase();
  const result = db
    .prepare(
      `UPDATE reminders SET status = 'cancelled'
       WHERE id = ? AND user_id = ? AND status = 'pending'`
    )
    .run(id, userId);
  return (result.changes as number) > 0;
}

export function snoozeReminder(id: number, userId: string, snoozeMs: number): boolean {
  const db = getDatabase();
  const newFireAt = Date.now() + snoozeMs;
  const result = db
    .prepare(
      `UPDATE reminders
       SET fire_at = ?, snoozed_count = snoozed_count + 1, status = 'pending'
       WHERE id = ? AND user_id = ?`
    )
    .run(newFireAt, id, userId);
  return (result.changes as number) > 0;
}

export function markFired(id: number): void {
  const db = getDatabase();
  db.prepare(`UPDATE reminders SET status = 'fired', last_fired_at = ? WHERE id = ?`).run(
    Date.now(),
    id
  );
}

// ─── Read ──────────────────────────────────────────────────────────────────────

export function getReminderById(id: number): Reminder | null {
  const db = getDatabase();
  const row = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id);
  return (row as unknown as Reminder) || null;
}

export function listPendingReminders(userId: string): Reminder[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM reminders
       WHERE user_id = ? AND status = 'pending'
       ORDER BY fire_at ASC`
    )
    .all(userId) as unknown as Reminder[];
}

/** Returns all reminders due right now across all users. */
export function getDueReminders(): Reminder[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM reminders
       WHERE status = 'pending' AND fire_at <= ?
       ORDER BY fire_at ASC`
    )
    .all(Date.now()) as unknown as Reminder[];
}
