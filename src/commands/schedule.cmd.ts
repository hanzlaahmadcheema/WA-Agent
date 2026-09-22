import type { CommandContext } from './types.js';
import {
  getDaySchedule,
  getNextLecture,
  getRemainingLectures,
  getFullWeekSchedule,
  resolveDayName,
} from '../schedule/schedule-service.js';
import {
  formatDayView,
  formatNextLectureView,
  formatRemainingView,
  formatFullWeekView,
  formatLectureReminderAlert,
  formatLectureReminderConfirmation,
  formatMinutesDuration,
  capitalize,
} from '../schedule/schedule-formatter.js';
import { createReminder, ensureRemindersTable } from '../reminders/reminder-repo.js';

/**
 * Parses duration strings like "15min", "15m", "1h 30m", "30 mins", "10" into total minutes.
 */
export function parseDurationToMinutes(input: string): number | null {
  const clean = input.trim().toLowerCase();
  if (!clean) return null;

  const tokenRegex = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i;

  let remaining = clean;
  let totalMinutes = 0;
  let matchedAny = false;

  while (remaining.length > 0) {
    const m = remaining.match(tokenRegex);
    if (!m) break;

    matchedAny = true;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();

    if (/^m/.test(unit)) totalMinutes += n;
    else if (/^h/.test(unit)) totalMinutes += n * 60;

    remaining = remaining.slice(m[0].length).trim();
  }

  if (!matchedAny) {
    const bareMatch = clean.match(/^(\d+)\b/);
    if (bareMatch) {
      return parseInt(bareMatch[1], 10);
    }
  }

  return matchedAny && totalMinutes > 0 ? totalMinutes : null;
}

/**
 * Handles /schedule, /timetable, /tt, /classes, and /lectures.
 *
 * Usage:
 *   /schedule                  -> Today's schedule + live status
 *   /schedule today            -> Today's schedule
 *   /schedule next             -> Next lecture only (with countdown)
 *   /schedule remaining        -> Remaining classes today
 *   /schedule tomorrow         -> Tomorrow's classes
 *   /schedule week             -> Full week timetable
 *   /schedule remind <lead>    -> Set reminder before next lecture (e.g. /schedule remind 15min)
 *   /schedule <day>            -> Schedule for specific day (e.g. monday, fri)
 */
export async function handleSchedule(ctx: CommandContext): Promise<string> {
  const { parsed } = ctx;
  const now = new Date();

  // Check if subcommand or first arg is 'remind' or 'alert'
  const sub = (parsed.subcommand || '').toLowerCase();
  const firstArg = (parsed.args[0] || '').toLowerCase();
  const isRemind =
    sub === 'remind' ||
    sub === 'alert' ||
    firstArg === 'remind' ||
    firstArg === 'alert';

  // 0. Lecture reminder: /schedule remind 15min
  if (isRemind) {
    let rawDuration = '';
    if (sub === 'remind' || sub === 'alert') {
      rawDuration = parsed.args.join(' ').trim() || parsed.rawTrailing || '';
    } else {
      rawDuration = parsed.args.slice(1).join(' ').trim();
    }

    // Default to 15min if no duration provided e.g. "/schedule remind"
    if (!rawDuration) {
      rawDuration = '15min';
    }

    const leadMinutes = parseDurationToMinutes(rawDuration);
    if (!leadMinutes || leadMinutes <= 0) {
      return [
        `❓ *Invalid Reminder Duration*: "${rawDuration}"`,
        '',
        '👉 *Usage:* `/schedule remind <duration>`',
        '*Examples:*',
        '• `/schedule remind 15min` _(or 15m)_',
        '• `/schedule remind 30m`',
        '• `/schedule remind 10min`',
        '• `/schedule remind 1h`',
      ].join('\n');
    }

    // Find next upcoming lecture
    const nextData = getNextLecture(now);
    if (!nextData || !nextData.next || !nextData.nextLectureDate) {
      return [
        '🎉 *No Upcoming Lectures Found!*',
        '',
        'There are currently no upcoming lectures on your schedule to set a reminder for.',
        '💡 Type `/schedule week` to view the full timetable.',
      ].join('\n');
    }

    const nextClass = nextData.next;
    const lectureDate = nextData.nextLectureDate;
    const fireTimeMs = lectureDate.getTime() - leadMinutes * 60 * 1000;
    const fireAt = new Date(fireTimeMs);

    // Check if the lead time has already passed
    if (fireTimeMs <= now.getTime()) {
      const msUntilLecture = lectureDate.getTime() - now.getTime();
      const minutesUntilLecture = Math.max(1, Math.round(msUntilLecture / 60_000));
      return [
        `⚠️ *Cannot Set Reminder*: The next lecture (*${nextClass.subject}*) starts in only *${formatMinutesDuration(minutesUntilLecture)}* (at ${nextClass.start}), which is less than your ${formatMinutesDuration(leadMinutes)} advance notification window.`,
        '',
        `🏛️ *Room:* ${nextClass.room}`,
        '💡 Type `/schedule next` to view lecture room and details now.',
      ].join('\n');
    }

    // Ensure database table exists and persist the reminder
    ensureRemindersTable();
    const reminderAlertMessage = formatLectureReminderAlert(nextClass, leadMinutes);
    const reminder = createReminder(ctx.user.id, reminderAlertMessage, fireAt);

    const dayLabel = nextData.isToday ? 'Today' : capitalize(nextData.day);
    return formatLectureReminderConfirmation(
      nextClass,
      fireAt,
      leadMinutes,
      dayLabel,
      reminder.id
    );
  }

  // Extract subcommand or first argument
  const arg = (
    parsed.subcommand ||
    parsed.args[0] ||
    parsed.rawTrailing ||
    ''
  ).trim().toLowerCase();

  // 1. Next lecture only
  if (arg === 'next' || arg === 'upcoming') {
    const nextData = getNextLecture(now);
    return formatNextLectureView(nextData?.title || 'University Schedule', nextData);
  }

  // 2. Remaining lectures today
  if (arg === 'remaining' || arg === 'left' || arg === 'rest') {
    const remData = getRemainingLectures(now);
    return formatRemainingView(
      remData.title,
      remData.day,
      remData.classes,
      remData.allDone,
      remData.nextDaySchedule
    );
  }

  // 3. Full weekly schedule
  if (arg === 'week' || arg === 'all' || arg === 'full' || arg === 'weekly') {
    const weekData = getFullWeekSchedule(now);
    return formatFullWeekView(weekData);
  }

  // 4. Specific day or relative day (today, tomorrow, monday, friday, etc.)
  const targetDay = resolveDayName(arg || 'today', now);
  if (targetDay) {
    const dayData = getDaySchedule(targetDay, now);
    return formatDayView(dayData.title, dayData.day, dayData.classes, dayData.isToday, now);
  }

  // Fallback: If unknown argument provided, explain usage and show today
  const dayData = getDaySchedule(resolveDayName('today', now) || 'monday', now);
  const todayOutput = formatDayView(dayData.title, dayData.day, dayData.classes, dayData.isToday, now);

  return [
    `❓ _Could not recognize day "${arg}". Showing today's schedule:_`,
    '',
    todayOutput,
  ].join('\n');
}
