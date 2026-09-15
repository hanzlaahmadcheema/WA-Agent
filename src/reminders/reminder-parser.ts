/**
 * reminder-parser.ts
 * Fully-fledged natural-language reminder parser supporting:
 * - Second-level precision ("in 15s", "at 14:30:15", "2026-09-15 14:30:15")
 * - Compound durations ("in 1h 30m 15s check the server")
 * - Recurring schedules:
 *   - Interval: "every 30s", "every 2h", "every 45m"
 *   - Daily: "every day at 9am", "daily at 18:30:15"
 *   - Weekly: "every monday at 10am", "weekly on friday at 5pm", "every weekday at 9am"
 *   - Monthly: "monthly on 1st at 10am", "every month on the 15th at 9am"
 * - Embedded natural phrasing ("drink water every 2h", "push code at 5pm")
 *
 * No AI/agent involved — 100% deterministic, high-performance regex & date math.
 */

export interface RecurrenceRule {
  type: 'interval' | 'daily' | 'weekly' | 'monthly';
  intervalMs?: number;            // for 'interval'
  time?: string;                  // 'HH:mm:ss' or 'HH:mm'
  daysOfWeek?: number[];          // 0 = Sun, 1 = Mon, ..., 6 = Sat
  dayOfMonth?: number;            // 1..31
  humanPattern: string;           // e.g. "Every day at 09:00:00", "Weekly on Monday", "Every 2 hours"
}

export interface ParsedReminder {
  fireAt: Date;                   // Next execution time
  message: string;                // Reminder payload text
  recurrence?: RecurrenceRule;    // Optional recurrence rule
}

const DAY_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTH_MAP: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/**
 * Main parse entry point.
 */
export function parseReminder(input: string): ParsedReminder | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Strip leading command or conversational prefix
  let rest: string;
  const cmdMatch = trimmed.match(/^\/(?:remind|reminders?)\s+(.*)/i);
  if (cmdMatch) {
    rest = cmdMatch[1].trim();
  } else {
    const nlMatch = trimmed.match(/^remind\s+(?:me\s+)?(?:to\s+)?(.*)/i);
    if (!nlMatch) return null;
    rest = nlMatch[1].trim();
  }

  if (!rest) return null;

  // 2. Try recurrence patterns first
  const recurring = tryRecurring(rest);
  if (recurring) return recurring;

  // 3. Try one-time expressions
  return (
    tryAbsoluteDateTime(rest) ||
    tryCompoundRelativeDuration(rest) ||
    tryRelativeDayWithTime(rest) ||
    tryTimeToday(rest) ||
    tryEmbeddedExpressions(rest) ||
    null
  );
}

// ─── Recurrence Parsers ───────────────────────────────────────────────────────

function tryRecurring(text: string): ParsedReminder | null {
  return (
    tryIntervalRecurrence(text) ||
    tryDailyRecurrence(text) ||
    tryWeeklyRecurrence(text) ||
    tryMonthlyRecurrence(text)
  );
}

/**
 * Interval recurrence:
 * "every 30s <msg>", "every 45 minutes <msg>", "every 2h <msg>", "every 1d <msg>"
 */
function tryIntervalRecurrence(text: string): ParsedReminder | null {
  const m = text.match(
    /^every\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s+(.*)/i
  );
  if (!m) return null;

  const count = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const msg = m[3].trim();
  if (!msg) return null;

  let intervalMs = 0;
  let unitLabel = 'second';
  if (/^s/.test(unit)) {
    intervalMs = count * 1_000;
    unitLabel = count === 1 ? 'second' : 'seconds';
  } else if (/^m/.test(unit)) {
    intervalMs = count * 60_000;
    unitLabel = count === 1 ? 'minute' : 'minutes';
  } else if (/^h/.test(unit)) {
    intervalMs = count * 3_600_000;
    unitLabel = count === 1 ? 'hour' : 'hours';
  } else if (/^d/.test(unit)) {
    intervalMs = count * 86_400_000;
    unitLabel = count === 1 ? 'day' : 'days';
  }

  if (intervalMs <= 0) return null;

  const rule: RecurrenceRule = {
    type: 'interval',
    intervalMs,
    humanPattern: `Every ${count} ${unitLabel}`,
  };

  const fireAt = new Date(Date.now() + intervalMs);
  return { fireAt, message: msg, recurrence: rule };
}

/**
 * Daily recurrence:
 * "every day at 9am <msg>", "every day at 09:30:15 <msg>", "daily at 18:00 <msg>", "daily <msg>"
 */
function tryDailyRecurrence(text: string): ParsedReminder | null {
  const m = text.match(
    /^(?:every\s+day|daily)(?:\s+at\s+(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:am|pm)?))?\s+(.*)/i
  );
  if (!m) return null;

  const timeStr = m[1];
  const msg = m[2].trim();
  if (!msg) return null;

  const parsedTime = timeStr ? parseTimeOfDay(timeStr) : { hours: 9, minutes: 0, seconds: 0 };
  if (!parsedTime) return null;

  const timeFormatted = formatTimeOfDay(parsedTime);
  const rule: RecurrenceRule = {
    type: 'daily',
    time: timeFormatted,
    humanPattern: `Daily at ${timeFormatted}`,
  };

  const fireAt = computeNextDailyFire(parsedTime);
  return { fireAt, message: msg, recurrence: rule };
}

/**
 * Weekly recurrence:
 * "every monday at 10am <msg>", "weekly on friday at 5pm <msg>", "every weekday at 9am <msg>", "every weekend at 11am <msg>"
 */
function tryWeeklyRecurrence(text: string): ParsedReminder | null {
  const m = text.match(
    /^(?:every|weekly(?:\s+on)?)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|weekdays?|weekends?)(?:\s+at\s+(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:am|pm)?))?\s+(.*)/i
  );
  if (!m) return null;

  const dayToken = m[1].toLowerCase();
  const timeStr = m[2];
  const msg = m[3].trim();
  if (!msg) return null;

  const parsedTime = timeStr ? parseTimeOfDay(timeStr) : { hours: 9, minutes: 0, seconds: 0 };
  if (!parsedTime) return null;

  let daysOfWeek: number[];
  let label = '';
  if (dayToken.startsWith('weekday')) {
    daysOfWeek = [1, 2, 3, 4, 5];
    label = 'Weekdays (Mon-Fri)';
  } else if (dayToken.startsWith('weekend')) {
    daysOfWeek = [0, 6];
    label = 'Weekends (Sat-Sun)';
  } else if (DAY_MAP[dayToken] !== undefined) {
    daysOfWeek = [DAY_MAP[dayToken]];
    label = capitalize(dayToken);
  } else {
    return null;
  }

  const timeFormatted = formatTimeOfDay(parsedTime);
  const rule: RecurrenceRule = {
    type: 'weekly',
    daysOfWeek,
    time: timeFormatted,
    humanPattern: `Weekly on ${label} at ${timeFormatted}`,
  };

  const fireAt = computeNextWeeklyFire(daysOfWeek, parsedTime);
  return { fireAt, message: msg, recurrence: rule };
}

/**
 * Monthly recurrence:
 * "monthly on 1st at 10am <msg>", "every month on the 15th at 9:00:00 <msg>", "monthly on 28th <msg>"
 */
function tryMonthlyRecurrence(text: string): ParsedReminder | null {
  const m = text.match(
    /^(?:monthly(?:\s+on)?|every\s+month(?:\s+on)?)\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+at\s+(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:am|pm)?))?\s+(.*)/i
  );
  if (!m) return null;

  const dayNum = parseInt(m[1], 10);
  if (dayNum < 1 || dayNum > 31) return null;

  const timeStr = m[2];
  const msg = m[3].trim();
  if (!msg) return null;

  const parsedTime = timeStr ? parseTimeOfDay(timeStr) : { hours: 9, minutes: 0, seconds: 0 };
  if (!parsedTime) return null;

  const timeFormatted = formatTimeOfDay(parsedTime);
  const rule: RecurrenceRule = {
    type: 'monthly',
    dayOfMonth: dayNum,
    time: timeFormatted,
    humanPattern: `Monthly on day ${dayNum} at ${timeFormatted}`,
  };

  const fireAt = computeNextMonthlyFire(dayNum, parsedTime);
  return { fireAt, message: msg, recurrence: rule };
}

// ─── One-Time Parsers ─────────────────────────────────────────────────────────

/**
 * Absolute dates:
 * - "2026-09-15 14:30:15 <msg>" or "2026-09-15T14:30:15 <msg>"
 * - "15/09/2026 14:30:15 <msg>" or "15-09-2026 14:30:15 <msg>"
 * - "15 Sep 2026 14:30:15 <msg>" or "Sep 15, 2026 14:30:15 <msg>"
 */
function tryAbsoluteDateTime(text: string): ParsedReminder | null {
  // ISO: YYYY-MM-DD[T ]HH:mm[:ss]
  const isoMatch = text.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?\s+(.*)/i
  );
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const hours = parseInt(isoMatch[4], 10);
    const minutes = parseInt(isoMatch[5], 10);
    const seconds = isoMatch[6] ? parseInt(isoMatch[6], 10) : 0;
    const msg = isoMatch[7].trim();
    const fireAt = new Date(year, month, day, hours, minutes, seconds);
    if (!isNaN(fireAt.getTime()) && fireAt > new Date() && msg) {
      return { fireAt, message: msg };
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = text.match(
    /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\s+(.*)/i
  );
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    const year = parseInt(dmyMatch[3], 10);
    let hours = parseInt(dmyMatch[4], 10);
    const minutes = parseInt(dmyMatch[5], 10);
    const seconds = dmyMatch[6] ? parseInt(dmyMatch[6], 10) : 0;
    const ampm = dmyMatch[7]?.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const msg = dmyMatch[8].trim();
    const fireAt = new Date(year, month, day, hours, minutes, seconds);
    if (!isNaN(fireAt.getTime()) && fireAt > new Date() && msg) {
      return { fireAt, message: msg };
    }
  }

  // Natural month: "15 Sep 2026 14:30:15 <msg>" or "Sep 15 2026 at 5pm <msg>"
  const naturalMatch = text.match(
    /^(?:(\d{1,2})\s+([a-z]+)|([a-z]+)\s+(\d{1,2}))(?:,?\s+(\d{4}))?\s+(?:at\s+)?(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:am|pm)?)\s+(.*)/i
  );
  if (naturalMatch) {
    const day = parseInt(naturalMatch[1] || naturalMatch[4], 10);
    const monthStr = (naturalMatch[2] || naturalMatch[3]).toLowerCase();
    const year = naturalMatch[5] ? parseInt(naturalMatch[5], 10) : new Date().getFullYear();
    const timeStr = naturalMatch[6];
    const msg = naturalMatch[7].trim();

    if (MONTH_MAP[monthStr] !== undefined && !isNaN(day)) {
      const parsedTime = parseTimeOfDay(timeStr);
      if (parsedTime && msg) {
        const fireAt = new Date(
          year,
          MONTH_MAP[monthStr],
          day,
          parsedTime.hours,
          parsedTime.minutes,
          parsedTime.seconds
        );
        if (!isNaN(fireAt.getTime()) && fireAt > new Date()) {
          return { fireAt, message: msg };
        }
      }
    }
  }

  return null;
}

/**
 * Compound relative duration:
 * "in 1h 30m 15s <msg>", "in 45s <msg>", "30s <msg>", "90 seconds <msg>"
 */
function tryCompoundRelativeDuration(text: string): ParsedReminder | null {
  const clean = text.replace(/^in\s+/i, '').trim();

  // Match one or more chained duration tokens at the start
  const tokenRegex = /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i;

  let remaining = clean;
  let totalMs = 0;
  let matchedAny = false;

  while (true) {
    const m = remaining.match(tokenRegex);
    if (!m) break;

    matchedAny = true;
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();

    if (/^s/.test(unit)) totalMs += n * 1_000;
    else if (/^m/.test(unit)) totalMs += n * 60_000;
    else if (/^h/.test(unit)) totalMs += n * 3_600_000;
    else if (/^d/.test(unit)) totalMs += n * 86_400_000;

    remaining = remaining.slice(m[0].length).trim();
  }

  if (!matchedAny || totalMs <= 0 || !remaining) return null;

  return {
    fireAt: new Date(Date.now() + totalMs),
    message: remaining,
  };
}

/**
 * Relative day with time:
 * "tomorrow at 9:30:15am <msg>", "tomorrow 9am <msg>", "tonight at 8pm <msg>",
 * "next monday at 10am <msg>", "this friday at 4:30pm <msg>"
 */
function tryRelativeDayWithTime(text: string): ParsedReminder | null {
  // Day of week: "next monday at 10am <msg>" or "this friday 5pm <msg>"
  const dowMatch = text.match(
    /^(next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\s+(?:at\s+)?(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:am|pm)?)\s+(.*)/i
  );
  if (dowMatch) {
    const dayName = dowMatch[2].toLowerCase();
    const targetDay = DAY_MAP[dayName];
    const timeStr = dowMatch[3];
    const msg = dowMatch[4].trim();

    const parsedTime = parseTimeOfDay(timeStr);
    if (parsedTime && targetDay !== undefined && msg) {
      const now = new Date();
      let dayOffset = (targetDay - now.getDay() + 7) % 7;
      if (dowMatch[1].toLowerCase() === 'next') {
        dayOffset = dayOffset === 0 ? 7 : dayOffset + 7;
      } else if (dayOffset === 0) {
        // "this <today>": if time has passed, next week
        const candidate = new Date(now);
        candidate.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);
        if (candidate <= now) dayOffset = 7;
      }
      const fireAt = new Date(now);
      fireAt.setDate(fireAt.getDate() + dayOffset);
      fireAt.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);
      return { fireAt, message: msg };
    }
  }

  // Tomorrow / tonight
  const m = text.match(
    /^(tomorrow|tonight)\s+(?:at\s+)?(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:am|pm)?)?\s*(.*)/i
  );
  if (m) {
    const dayWord = m[1].toLowerCase();
    const timeStr = m[2];
    const msg = m[3].trim();
    if (!msg) return null;

    let parsedTime: { hours: number; minutes: number; seconds: number } | null;
    if (timeStr) {
      parsedTime = parseTimeOfDay(timeStr);
    } else {
      parsedTime = dayWord === 'tonight'
        ? { hours: 20, minutes: 0, seconds: 0 }
        : { hours: 9, minutes: 0, seconds: 0 };
    }
    if (!parsedTime) return null;

    const fireAt = new Date();
    if (dayWord === 'tomorrow') fireAt.setDate(fireAt.getDate() + 1);
    fireAt.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);
    // If tonight time is already past, move to tomorrow night
    if (fireAt <= new Date()) fireAt.setDate(fireAt.getDate() + 1);

    return { fireAt, message: msg };
  }

  return null;
}

/**
 * Time today / tomorrow:
 * "at 14:30:15 <msg>", "at 5pm <msg>", "5:30am <msg>", "14:30 <msg>"
 */
function tryTimeToday(text: string): ParsedReminder | null {
  const m = text.match(/^(?:at\s+)?(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:am|pm)?)\s+(.*)/i);
  if (!m) return null;

  const parsedTime = parseTimeOfDay(m[1]);
  const msg = m[2].trim();
  if (!parsedTime || !msg) return null;

  const now = new Date();
  const fireAt = new Date(now);
  fireAt.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);

  // If time has already passed today, schedule for tomorrow
  if (fireAt <= now) fireAt.setDate(fireAt.getDate() + 1);

  return { fireAt, message: msg };
}

/**
 * Embedded expressions where message appears first:
 * - "drink water every 2h"
 * - "standup every day at 9am"
 * - "push code at 5pm"
 * - "restart service in 45s"
 */
function tryEmbeddedExpressions(text: string): ParsedReminder | null {
  // 1. Embedded recurrence: "<msg> every ..."
  const everyMatch = text.match(/^(.+?)\s+(every\s+.+)$/i);
  if (everyMatch) {
    const rec = tryRecurring(everyMatch[2].trim() + ' ' + everyMatch[1].trim());
    if (rec) return rec;
  }

  // 2. Embedded in duration: "<msg> in 45s"
  const inMatch = text.match(/^(.+?)\s+in\s+(\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))$/i);
  if (inMatch) {
    return tryCompoundRelativeDuration(`in ${inMatch[2]} ${inMatch[1]}`);
  }

  // 3. Embedded at time: "<msg> at 14:30:15" or "<msg> at 5pm"
  const atMatch = text.match(/^(.+?)\s+at\s+(\d{1,2}(?::\d{2}(?::\d{2})?)?\s*(?:am|pm)?)$/i);
  if (atMatch) {
    const parsedTime = parseTimeOfDay(atMatch[2]);
    const msg = atMatch[1].trim();
    if (parsedTime && msg) {
      const now = new Date();
      const fireAt = new Date(now);
      fireAt.setHours(parsedTime.hours, parsedTime.minutes, parsedTime.seconds, 0);
      if (fireAt <= now) fireAt.setDate(fireAt.getDate() + 1);
      return { fireAt, message: msg };
    }
  }

  return null;
}

// ─── Time Math & Helpers ──────────────────────────────────────────────────────

export function parseTimeOfDay(
  timeStr: string
): { hours: number; minutes: number; seconds: number } | null {
  const trimmed = timeStr.trim();

  // HH:mm:ss [am/pm] or HH:mm [am/pm]
  const m = trimmed.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;

  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const seconds = m[3] ? parseInt(m[3], 10) : 0;
  const ampm = m[4]?.toLowerCase();

  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }

  return { hours, minutes, seconds };
}

export function formatTimeOfDay(t: { hours: number; minutes: number; seconds: number }): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.hours)}:${pad(t.minutes)}:${pad(t.seconds)}`;
}

/**
 * Calculates the next occurrence for a given recurrence rule.
 */
export function computeNextRecurrence(rule: RecurrenceRule, baseTime: Date = new Date()): Date {
  switch (rule.type) {
    case 'interval': {
      const interval = rule.intervalMs || 60_000;
      let next = baseTime.getTime() + interval;
      if (next <= Date.now()) {
        const elapsed = Date.now() - baseTime.getTime();
        const cycles = Math.floor(elapsed / interval) + 1;
        next = baseTime.getTime() + cycles * interval;
      }
      return new Date(next);
    }

    case 'daily': {
      const parsed = parseTimeOfDay(rule.time || '09:00:00') || { hours: 9, minutes: 0, seconds: 0 };
      return computeNextDailyFire(parsed, baseTime);
    }

    case 'weekly': {
      const parsed = parseTimeOfDay(rule.time || '09:00:00') || { hours: 9, minutes: 0, seconds: 0 };
      const days = rule.daysOfWeek && rule.daysOfWeek.length ? rule.daysOfWeek : [1];
      return computeNextWeeklyFire(days, parsed, baseTime);
    }

    case 'monthly': {
      const parsed = parseTimeOfDay(rule.time || '09:00:00') || { hours: 9, minutes: 0, seconds: 0 };
      const dayNum = rule.dayOfMonth || 1;
      return computeNextMonthlyFire(dayNum, parsed, baseTime);
    }
  }
}

function computeNextDailyFire(
  parsed: { hours: number; minutes: number; seconds: number },
  baseTime: Date = new Date()
): Date {
  const candidate = new Date(baseTime);
  candidate.setHours(parsed.hours, parsed.minutes, parsed.seconds, 0);
  if (candidate.getTime() <= baseTime.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

function computeNextWeeklyFire(
  daysOfWeek: number[],
  parsed: { hours: number; minutes: number; seconds: number },
  baseTime: Date = new Date()
): Date {
  for (let offset = 0; offset <= 14; offset++) {
    const candidate = new Date(baseTime);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(parsed.hours, parsed.minutes, parsed.seconds, 0);
    if (candidate.getTime() > baseTime.getTime() && daysOfWeek.includes(candidate.getDay())) {
      return candidate;
    }
  }
  // Fallback 7 days ahead
  const fallback = new Date(baseTime);
  fallback.setDate(fallback.getDate() + 7);
  return fallback;
}

function computeNextMonthlyFire(
  targetDay: number,
  parsed: { hours: number; minutes: number; seconds: number },
  baseTime: Date = new Date()
): Date {
  for (let mOffset = 0; mOffset <= 12; mOffset++) {
    const y = baseTime.getFullYear();
    const mon = baseTime.getMonth() + mOffset;
    const maxDays = new Date(y, mon + 1, 0).getDate();
    const actualDay = Math.min(targetDay, maxDays);
    const candidate = new Date(y, mon, actualDay, parsed.hours, parsed.minutes, parsed.seconds, 0);
    if (candidate.getTime() > baseTime.getTime()) {
      return candidate;
    }
  }
  // Fallback 30 days ahead
  const fallback = new Date(baseTime);
  fallback.setDate(fallback.getDate() + 30);
  return fallback;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
