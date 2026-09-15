/**
 * remind.cmd.ts
 * Command handler for /remind, /reminders, and /remind cancel.
 * Supports second-level precision, absolute dates, and daily/weekly/monthly/interval recurrence.
 * No AI/agent involvement — pure bot-side control plane.
 */

import type { CommandContext } from './types.js';
import { parseReminder } from '../reminders/reminder-parser.js';
import { createReminder, cancelReminder, listPendingReminders } from '../reminders/reminder-repo.js';
import { formatReminderList } from '../reminders/reminder-scheduler.js';
import { formatDistanceToNow, formatPreciseCountdown, formatDateTimeFull } from '../reminders/reminder-formatter.js';

export async function handleRemind(ctx: CommandContext): Promise<string> {
  const { user, parsed } = ctx;
  const sub = parsed.subcommand;

  // 1. /reminders or /remind (no args) → List active reminders
  if (!parsed.rawTrailing && (!parsed.args.length || sub === 'list')) {
    return formatReminderList(user.id);
  }

  // 2. /remind cancel <n> or /remind delete <n>
  if ((sub === 'cancel' || sub === 'delete') && parsed.args.length > 0) {
    const targetNum = parseInt(parsed.args[0], 10);
    const pending = listPendingReminders(user.id);

    // Support both 1-based index from list and direct reminder database ID
    const target =
      pending[targetNum - 1] || pending.find((r) => r.id === targetNum);

    if (!target) {
      return `❌ No reminder #${targetNum} found.\nType \`/reminders\` to view active reminders.`;
    }

    const cancelled = cancelReminder(target.id, user.id);
    if (!cancelled) {
      return `❌ Could not cancel reminder #${targetNum}.`;
    }

    return `✅ Cancelled: _"${target.message}"_`;
  }

  // 3. /remind <time/schedule> <message>
  const rawInput = parsed.rawTrailing || parsed.args.join(' ');
  if (!rawInput) {
    return formatReminderUsage();
  }

  // Parse natural language or structured time/recurrence
  const parsed_reminder = parseReminder(`/remind ${rawInput}`);
  if (!parsed_reminder) {
    return [
      '❓ *Could not understand the time or schedule.*',
      '',
      formatReminderUsage(),
    ].join('\n');
  }

  if (!parsed_reminder.message) {
    return [
      '❓ *Please include a message for your reminder.*',
      'Example: `/remind in 45s restart docker`',
      'Example: `/remind every day at 9am morning standup`',
    ].join('\n');
  }

  const r = createReminder(
    user.id,
    parsed_reminder.message,
    parsed_reminder.fireAt,
    parsed_reminder.recurrence
  );

  const fireDate = new Date(r.fire_at);
  const timeStr = formatDateTimeFull(fireDate);
  const countdown = formatPreciseCountdown(fireDate);

  if (parsed_reminder.recurrence) {
    return [
      '🔄 *Recurring Reminder Scheduled!*',
      '',
      `📝 _"${r.message}"_`,
      `🔁 *Schedule:* ${parsed_reminder.recurrence.humanPattern}`,
      `🕐 *First run:* ${timeStr}`,
      `⏳ *In:* ${countdown}`,
      '',
      'Type `/reminders` to view list • `/remind cancel 1` to stop',
    ].join('\n');
  }

  return [
    '✅ *Reminder Scheduled!*',
    '',
    `📝 _"${r.message}"_`,
    `🕐 *When:* ${timeStr}`,
    `⏳ *In:* ${countdown}`,
    '',
    'Type `/reminders` to view list • `/remind cancel 1` to remove',
  ].join('\n');
}

function formatReminderUsage(): string {
  return [
    '⏰ *WA-Agent Reminders (High-Precision & Recurring)*',
    '',
    '⏱️ *Second Precision & Relative Times:*',
    '  `/remind 30s quick check`',
    '  `/remind in 1m 45s restart daemon`',
    '  `/remind 2h review pull request`',
    '',
    '📅 *Specific Date & Time:*',
    '  `/remind at 14:30:15 team sync`',
    '  `/remind tomorrow at 9:30am standup`',
    '  `/remind 2026-09-20 15:00:00 project deadline`',
    '  `/remind 25 Sep 2026 at 5pm client meeting`',
    '',
    '🔁 *Recurring (Daily / Weekly / Monthly / Interval):*',
    '  `/remind every 30s test ping`',
    '  `/remind every 2h drink water`',
    '  `/remind every day at 9am standup`',
    '  `/remind daily at 18:30 gym session`',
    '  `/remind every monday at 10am sprint planning`',
    '  `/remind weekly on friday at 5pm submit report`',
    '  `/remind every weekday at 9am check inbox`',
    '  `/remind monthly on 1st at 10am pay rent`',
    '',
    '💬 *Natural Phrasing (No Slash Needed):*',
    '  `remind me to push at 5pm`',
    '  `remind me to take medicine every day at 8pm`',
    '',
    '📋 *Manage Reminders:*',
    '  `/reminders`           • View all active reminders',
    '  `/remind cancel <n>`   • Cancel a reminder by number or ID',
  ].join('\n');
}
