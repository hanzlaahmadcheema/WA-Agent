/**
 * reminder-scheduler.ts
 * High-precision background scheduler (1s resolution) for one-time and recurring reminders.
 * Dispatches via Baileys and manages interactive snooze/cancel replies.
 * No AI/agent involved — pure bot-side event loop.
 */

import {
  getDueReminders,
  markFired,
  cancelReminder,
  listPendingReminders,
  advanceRecurringReminder,
  snoozeReminder,
  getReminderById,
} from './reminder-repo.js';
import { logger } from '../logger.js';
import {
  formatDistanceToNow,
  formatPreciseCountdown,
  formatDateTimeFull,
} from './reminder-formatter.js';
import { computeNextRecurrence, type RecurrenceRule } from './reminder-parser.js';

type SendFn = (jid: string, text: string) => Promise<void>;

let _send: SendFn | null = null;
let _interval: ReturnType<typeof setInterval> | null = null;

// In-memory map: userId → last fired reminderId (for context-aware snooze/cancel reply)
const lastFiredReminder = new Map<string, number>();

export function startReminderScheduler(send: SendFn): void {
  if (_interval) return; // Already running
  _send = send;

  // 1-second resolution check loop
  _interval = setInterval(async () => {
    try {
      const due = getDueReminders();
      if (due.length === 0) return;

      for (const r of due) {
        lastFiredReminder.set(r.user_id, r.id);

        if (r.recurrence_type && r.recurrence_rule) {
          // Recurring reminder
          try {
            const rule: RecurrenceRule = JSON.parse(r.recurrence_rule);
            const nextFire = computeNextRecurrence(rule, new Date());
            advanceRecurringReminder(r.id, nextFire.getTime());

            const nextTimeStr = formatDateTimeFull(nextFire);
            const countdown = formatDistanceToNow(nextFire);

            await _send!(
              r.user_id,
              [
                `🔄 *Reminder (${rule.humanPattern})*`,
                '',
                r.message,
                '',
                `⏭️ *Next:* ${nextTimeStr} _(in ${countdown})_`,
                `_Reply_ \`/remind cancel ${r.id}\` _to cancel_`,
              ].join('\n')
            );
            logger.info({ reminderId: r.id, userId: r.user_id, nextFire: nextTimeStr }, 'reminder.recurring_fired');
          } catch (err: any) {
            logger.error({ error: err.message, reminderId: r.id }, 'reminder.recurrence_compute_error');
            markFired(r.id);
          }
        } else {
          // One-time reminder
          markFired(r.id);
          const snoozeNote = r.snoozed_count > 0 ? ` _(snoozed ${r.snoozed_count}x)_` : '';
          await _send!(
            r.user_id,
            [
              `⏰ *Reminder*${snoozeNote}`,
              '',
              r.message,
              '',
              '_Reply_ `snooze 15m` • `snooze 1h` • `cancel` _to manage_',
            ].join('\n')
          );
          logger.info({ reminderId: r.id, userId: r.user_id }, 'reminder.one_time_fired');
        }
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'reminder.scheduler_error');
    }
  }, 1_000);

  logger.info('reminder.scheduler.started (1s resolution)');
}

export function stopReminderScheduler(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

/**
 * Handles conversational reply to a fired reminder:
 * "snooze 30s", "snooze 15m", "snooze 1h", "cancel", etc.
 */
export function handleReminderReply(userId: string, text: string): string | null {
  const lastId = lastFiredReminder.get(userId);
  if (!lastId) return null;

  const lower = text.trim().toLowerCase();

  // Cancel
  if (lower === 'cancel' || lower === 'cancel reminder') {
    const ok = cancelReminder(lastId, userId);
    lastFiredReminder.delete(userId);
    return ok
      ? '✅ Reminder cancelled.'
      : '❌ Could not cancel — reminder may have already been cancelled.';
  }

  // Snooze
  const snoozeMatch = lower.match(
    /^snooze\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)/i
  );
  if (snoozeMatch) {
    const n = parseInt(snoozeMatch[1], 10);
    const unit = snoozeMatch[2].toLowerCase();
    let ms = 0;

    if (/^s/.test(unit)) ms = n * 1_000;
    else if (/^m/.test(unit)) ms = n * 60_000;
    else if (/^h/.test(unit)) ms = n * 3_600_000;
    else if (/^d/.test(unit)) ms = n * 86_400_000;

    if (ms > 0) {
      snoozeReminder(lastId, userId, ms);
      lastFiredReminder.delete(userId);
      const newFireDate = new Date(Date.now() + ms);
      const fireTime = formatDateTimeFull(newFireDate);
      return `⏱️ Snoozed! Will remind you again at ${fireTime}.`;
    }
  }

  return null;
}

/**
 * Formats user's pending reminders with full datetime, recurrence details, and countdown.
 */
export function formatReminderList(userId: string): string {
  const pending = listPendingReminders(userId);
  if (pending.length === 0) {
    return [
      '📭 *No pending reminders.*',
      '',
      '*Set one with:*',
      '• `/remind 30s quick check`',
      '• `/remind at 5pm push release`',
      '• `/remind every day at 9am morning standup`',
      '• `/remind weekly on monday at 10am sprint planning`',
      '• `/remind every 2h drink water`',
      '• `remind me to push at 5pm` _(natural speech)_',
    ].join('\n');
  }

  const lines = [`⏰ *Your Reminders (${pending.length})*`, ''];

  pending.forEach((r, i) => {
    const fireDate = new Date(r.fire_at);
    const timeStr = formatDateTimeFull(fireDate);
    const countdown = formatDistanceToNow(fireDate);
    const preciseCountdown = formatPreciseCountdown(fireDate);
    const snoozeTag = r.snoozed_count > 0 ? ` _(snoozed ${r.snoozed_count}x)_` : '';

    if (r.recurrence_type && r.recurrence_rule) {
      try {
        const rule: RecurrenceRule = JSON.parse(r.recurrence_rule);
        lines.push(`*${i + 1}.* 🔁 [${rule.humanPattern}] ${r.message}${snoozeTag}`);
      } catch {
        lines.push(`*${i + 1}.* 🔁 [Recurring] ${r.message}${snoozeTag}`);
      }
      lines.push(`   ⏭️ Next: ${timeStr} _(${preciseCountdown})_`);
    } else {
      lines.push(`*${i + 1}.* ⏰ [One-time] ${r.message}${snoozeTag}`);
      lines.push(`   🕐 Time: ${timeStr} _(${preciseCountdown})_`);
    }
    lines.push('');
  });

  lines.push('Reply `/remind cancel <n>` to stop any reminder.');
  return lines.join('\n');
}
