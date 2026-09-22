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
} from '../schedule/schedule-formatter.js';

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
 *   /schedule <day>            -> Schedule for specific day (e.g. monday, fri)
 */
export async function handleSchedule(ctx: CommandContext): Promise<string> {
  const { parsed } = ctx;
  const now = new Date();

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
