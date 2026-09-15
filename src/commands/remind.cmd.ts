/**
 * remind.cmd.ts
 * Handles /remind, /reminders, and cancel <n> commands.
 * No AI/agent involvement — pure bot logic.
 *
 * Commands:
 *   /remind <time> <message>      → set a reminder
 *   /reminders                    → list pending reminders
 *   /remind cancel <n>            → cancel reminder #n from list
 */

import type { CommandContext } from './types.js';
import { parseReminder } from '../reminders/reminder-parser.js';
import { createReminder, cancelReminder, listPendingReminders } from '../reminders/reminder-repo.js';
import { formatReminderList } from '../reminders/reminder-scheduler.js';
import { formatDistanceToNow } from '../reminders/reminder-formatter.js';

export async function handleRemind(ctx: CommandContext): Promise<string> {
  const { user, parsed } = ctx;
  const sub = parsed.subcommand;

  // /reminders → list
  if (!parsed.rawTrailing && (!parsed.args.length || sub === 'list')) {
    return formatReminderList(user.id);
  }

  // /remind cancel <n> or /remind delete <n>
  if ((sub === 'cancel' || sub === 'delete') && parsed.args.length > 0) {
    const n = parseInt(parsed.args[0], 10);
    const pending = listPendingReminders(user.id);
    const target = pending[n - 1];
    if (!target) {
      return `❌ No reminder #${n}. Use \`/reminders\` to view your list.`;
    }
    cancelReminder(target.id, user.id);
    return `✅ Cancelled: _"${target.message}"_`;
  }

  // /remind <time> <message>
  const rawInput = parsed.rawTrailing || parsed.args.join(' ');
  if (!rawInput) {
    return formatReminderUsage();
  }

  // Try natural-language parse
  const parsed_reminder = parseReminder(`/remind ${rawInput}`);
  if (!parsed_reminder) {
    return [
      '❓ *Could not understand the time.*',
      '',
      formatReminderUsage(),
    ].join('\n');
  }

  if (!parsed_reminder.message) {
    return '❓ *Please include a message for the reminder.*\nExample: `/remind 30m push the release`';
  }

  const r = createReminder(user.id, parsed_reminder.message, parsed_reminder.fireAt);
  const fireDate = new Date(r.fire_at);
  const timeStr = fireDate.toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const countdown = formatDistanceToNow(fireDate);

  return [
    `✅ *Reminder Set!*`,
    '',
    `📝 _"${r.message}"_`,
    `🕐 *When:* ${timeStr}`,
    `⏳ *In:* ${countdown}`,
    '',
    `Reply \`/reminders\` to view all • \`/remind cancel 1\` to remove`,
  ].join('\n');
}

function formatReminderUsage(): string {
  return [
    '⏰ *Set a Reminder*',
    '',
    '*Examples:*',
    '  `/remind 30m check build logs`',
    '  `/remind 2h review the PR`',
    '  `/remind at 5pm push the release`',
    '  `/remind tomorrow 9am standup`',
    '  `/remind 2026-09-20 14:00 deploy`',
    '',
    '  `remind me to push at 5pm`  _(no slash needed!)_',
    '',
    '*List reminders:* `/reminders`',
    '*Cancel one:* `/remind cancel 1`',
  ].join('\n');
}
