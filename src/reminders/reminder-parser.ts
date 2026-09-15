/**
 * reminder-parser.ts
 * Parses natural-language reminder time expressions into a future Date.
 * No AI/agent involved — pure string matching.
 */

export interface ParsedReminder {
  fireAt: Date;     // When to fire
  message: string;  // What to say
}

/**
 * Try to parse a reminder from any natural-language string.
 * Returns null if the string doesn't look like a reminder request.
 *
 * Examples:
 *   "remind me to push at 5pm"
 *   "/remind 30m check build logs"
 *   "remind me tomorrow 9am standup"
 *   "/remind 2h review PR"
 *   "remind me 2026-09-16 14:00 deploy"
 */
export function parseReminder(input: string): ParsedReminder | null {
  const trimmed = input.trim();

  // Strip leading /remind or "remind me (to)?"
  let rest: string;
  const cmdMatch = trimmed.match(/^\/remind\s+(.*)/i);
  if (cmdMatch) {
    rest = cmdMatch[1].trim();
  } else {
    const nlMatch = trimmed.match(/^remind\s+(?:me\s+)?(?:to\s+)?(.*)/i);
    if (!nlMatch) return null;
    rest = nlMatch[1].trim();
  }

  if (!rest) return null;

  // Try each time format in order of specificity
  return (
    tryAbsoluteDateTime(rest) ||
    tryRelativeDuration(rest) ||
    tryTimeToday(rest) ||
    tryRelativeDay(rest) ||
    tryEmbeddedAtTime(rest) ||
    null
  );
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

/** "2026-09-16 14:00 <message>" or "2026-09-16T14:00 <message>" */
function tryAbsoluteDateTime(rest: string): ParsedReminder | null {
  const m = rest.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})\s+(.*)/i);
  if (!m) return null;
  const fireAt = new Date(`${m[1]}T${m[2]}:00`);
  if (isNaN(fireAt.getTime()) || fireAt <= new Date()) return null;
  return { fireAt, message: m[3].trim() };
}

/** "30m <message>", "2h <message>", "90s <message>", "1d <message>" */
function tryRelativeDuration(rest: string): ParsedReminder | null {
  const m = rest.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s+(.*)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  let ms = 0;
  if (/^s/.test(unit)) ms = n * 1000;
  else if (/^m/.test(unit)) ms = n * 60_000;
  else if (/^h/.test(unit)) ms = n * 3_600_000;
  else if (/^d/.test(unit)) ms = n * 86_400_000;
  if (ms <= 0) return null;
  return { fireAt: new Date(Date.now() + ms), message: m[3].trim() };
}

/** "at 5pm <message>", "5:30am <message>", "17:00 <message>" */
function tryTimeToday(rest: string): ParsedReminder | null {
  const m = rest.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(.*)/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;

  const now = new Date();
  const fireAt = new Date(now);
  fireAt.setHours(hours, minutes, 0, 0);

  // If time has already passed today, fire tomorrow
  if (fireAt <= now) fireAt.setDate(fireAt.getDate() + 1);

  return { fireAt, message: m[4].trim() };
}

/** "tomorrow 9am <message>", "tomorrow <message>" */
function tryRelativeDay(rest: string): ParsedReminder | null {
  const m = rest.match(/^(tomorrow|tonight|tonight)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(.*)/i);
  if (m) {
    let hours = parseInt(m[2], 10);
    const minutes = m[3] ? parseInt(m[3], 10) : 0;
    const ampm = m[4]?.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;

    const fireAt = new Date();
    if (m[1].toLowerCase() === 'tomorrow') fireAt.setDate(fireAt.getDate() + 1);
    fireAt.setHours(hours, minutes, 0, 0);
    return { fireAt, message: m[5].trim() };
  }

  // "tomorrow <message>" — default to 9am
  const m2 = rest.match(/^tomorrow\s+(.*)/i);
  if (m2) {
    const fireAt = new Date();
    fireAt.setDate(fireAt.getDate() + 1);
    fireAt.setHours(9, 0, 0, 0);
    return { fireAt, message: m2[1].trim() };
  }

  return null;
}

/**
 * "<message> at 5pm", "<message> at 17:00" — time embedded anywhere with "at"
 * e.g. "push at 5pm" → message="push", fireAt=17:00 today/tomorrow
 */
function tryEmbeddedAtTime(rest: string): ParsedReminder | null {
  const m = rest.match(/^(.+?)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  const msg = m[1].trim();
  let hours = parseInt(m[2], 10);
  const minutes = m[3] ? parseInt(m[3], 10) : 0;
  const ampm = m[4]?.toLowerCase();
  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;

  const now = new Date();
  const fireAt = new Date(now);
  fireAt.setHours(hours, minutes, 0, 0);
  if (fireAt <= now) fireAt.setDate(fireAt.getDate() + 1);

  return { fireAt, message: msg };
}
