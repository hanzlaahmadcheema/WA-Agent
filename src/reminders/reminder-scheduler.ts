/**
 * reminder-scheduler.ts
 * Polls every 60s, fires due reminders via Baileys, handles snooze replies.
 * No AI/agent involved — pure bot-side timer logic.
 */

import { getDueReminders, markFired, snoozeReminder, cancelReminder, listPendingReminders } from './reminder-repo.js';
import { logger } from '../logger.js';
import { formatDistanceToNow } from '../reminders/reminder-formatter.js';
import { getDatabase } from '../database/connection.js';

type SendFn = (jid: string, text: string) => Promise<void>;

let _send: SendFn | null = null;
let _interval: ReturnType<typeof setInterval> | null = null;

// In-memory map: userId → last fired reminderId (for snooze/cancel reply)
const lastFiredReminder = new Map<string, number>();

export function startReminderScheduler(send: SendFn): void {
  if (_interval) return; // Already running
  _send = send;

  _interval = setInterval(async () => {
    try {
      const due = getDueReminders();
      for (const r of due) {
        markFired(r.id);
        lastFiredReminder.set(r.user_id, r.id);
        const snoozeNote = r.snoozed_count > 0 ? ` _(snoozed ${r.snoozed_count}x)_` : '';
        await _send!(r.user_id, [
          `⏰ *Reminder*${snoozeNote}`,
          '',
          r.message,
          '',
          '_Reply_ `snooze 15m` • `snooze 1h` • `cancel` _to manage_',
        ].join('\n'));
        logger.info({ reminderId: r.id, userId: r.user_id }, 'reminder.fired');
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'reminder.scheduler_error');
    }
  }, 60_000);

  logger.info('reminder.scheduler.started');
}

export function stopReminderScheduler(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

/**
 * Handle a reply to a fired reminder:
 * "snooze 15m" / "snooze 1h" / "cancel"
 * Returns a response string, or null if not a snooze/cancel reply.
 */
export function handleReminderReply(userId: string, text: string): string | null {
  const lastId = lastFiredReminder.get(userId);
  if (!lastId) return null;

  const lower = text.trim().toLowerCase();

  // cancel
  if (lower === 'cancel' || lower === 'cancel reminder') {
    const ok = cancelReminder(lastId, userId);
    lastFiredReminder.delete(userId);
    return ok
      ? '✅ Reminder cancelled.'
      : '❌ Could not cancel — reminder may have already fired or been cancelled.';
  }

  // snooze <duration>
  const snoozeMatch = lower.match(/^snooze\s+(\d+)\s*(s|m|h|min|mins|hr|hrs|minute|minutes|hour|hours)/);
  if (snoozeMatch) {
    const n = parseInt(snoozeMatch[1], 10);
    const unit = snoozeMatch[2];
    let ms = 0;
    if (/^s/.test(unit)) ms = n * 1_000;
    else if (/^m/.test(unit)) ms = n * 60_000;
    else if (/^h/.test(unit)) ms = n * 3_600_000;

    if (ms > 0) {
      // Re-set status to pending with new fire_at
      const db = getDatabase();
      const newFireAt = Date.now() + ms;
      db.prepare(
        `UPDATE reminders SET status = 'pending', fire_at = ?, snoozed_count = snoozed_count + 1 WHERE id = ? AND user_id = ?`
      ).run(newFireAt, lastId, userId);
      lastFiredReminder.delete(userId);
      const fireTime = new Date(newFireAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `⏱️ Snoozed! Will remind you again at ${fireTime}.`;
    }
  }

  return null;
}

/**
 * List pending reminders for a user as a formatted string.
 */
export function formatReminderList(userId: string): string {
  const pending = listPendingReminders(userId);
  if (pending.length === 0) {
    return '📭 *No pending reminders.*\n\nSet one with:\n`/remind 30m check the build`\n`remind me at 5pm push the release`';
  }

  const lines = [`⏰ *Your Reminders* (${pending.length})\n`];
  pending.forEach((r, i) => {
    const fireDate = new Date(r.fire_at);
    const timeStr = fireDate.toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const countdown = formatDistanceToNow(fireDate);
    const snoozeTag = r.snoozed_count > 0 ? ` _(snoozed ${r.snoozed_count}x)_` : '';
    lines.push(`*${i + 1}.* ${r.message}${snoozeTag}`);
    lines.push(`   🕐 ${timeStr} _(in ${countdown})_`);
  });

  lines.push('\nReply with the number to cancel: e.g. `cancel 2`');
  return lines.join('\n');
}
