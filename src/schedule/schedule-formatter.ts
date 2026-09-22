import type { ClassWithStatus, DayName } from './schedule-types.js';

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatMinutesDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) return 'now';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function getClassEmoji(type?: string): string {
  const lower = (type || '').toLowerCase();
  if (lower.includes('lab')) return '🧪';
  if (lower.includes('workshop')) return '🛠️';
  return '📖';
}

function formatClassCard(c: ClassWithStatus, index: number, isToday: boolean): string {
  const emoji = getClassEmoji(c.type);
  let statusBadge = '';

  if (isToday) {
    if (c.status === 'ongoing') {
      const endsIn = c.minutesUntilEnd ? formatMinutesDuration(c.minutesUntilEnd) : '';
      statusBadge = `  🟢 *[ONGOING${endsIn ? ` • Ends in ${endsIn}` : ''}]*`;
    } else if (c.status === 'upcoming') {
      const startsIn = c.minutesUntilStart ? formatMinutesDuration(c.minutesUntilStart) : '';
      statusBadge = `  ⏳ *[In ${startsIn}]*`;
    } else {
      statusBadge = '  ⚪ _[Finished]_';
    }
  }

  const typeBadge = c.type ? ` _(${c.type})_` : '';

  return [
    `*${index + 1}.* ${emoji} *${c.subject}*${typeBadge}${statusBadge}`,
    `   ⏰ ${c.start} – ${c.end} _(${formatMinutesDuration(c.durationMinutes)})_`,
    `   🏛️ *Room:* ${c.room}`,
  ].join('\n');
}

/**
 * Formats schedule for a single day.
 */
export function formatDayView(
  title: string,
  day: DayName,
  classes: ClassWithStatus[],
  isToday: boolean,
  now: Date = new Date()
): string {
  const dayTitle = capitalize(day);
  const dateFormatted = now.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    weekday: 'long',
  });

  const lines: string[] = [
    `🎓 *${title}*`,
    `📅 *${dayTitle} Schedule* ${isToday ? `_(Today, ${dateFormatted})_` : ''}`,
    '━━━━━━━━━━━━━━━━━━━━',
  ];

  if (classes.length === 0) {
    lines.push('');
    lines.push('🎉 *No lectures scheduled for this day!*');
    lines.push('_Enjoy your free time or prepare for upcoming classes._');
    lines.push('');
    lines.push('💡 Type `/schedule week` to view the full timetable.');
    return lines.join('\n');
  }

  lines.push('');
  classes.forEach((c, idx) => {
    lines.push(formatClassCard(c, idx, isToday));
    lines.push('');
  });

  // Summary footer
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  if (isToday) {
    const ongoing = classes.filter((c) => c.status === 'ongoing').length;
    const upcoming = classes.filter((c) => c.status === 'upcoming').length;
    const finished = classes.filter((c) => c.status === 'finished').length;
    lines.push(`📊 *Today:* ${classes.length} classes total (${finished} finished, ${ongoing} active, ${upcoming} remaining)`);
  } else {
    lines.push(`📊 *Total:* ${classes.length} classes scheduled for ${dayTitle}`);
  }

  lines.push('');
  lines.push('💡 *Commands:* `/schedule next` • `/schedule remaining` • `/schedule week`');
  return lines.join('\n');
}

/**
 * Formats dedicated view for next lecture only.
 */
export function formatNextLectureView(
  title: string,
  data: {
    current?: ClassWithStatus;
    next?: ClassWithStatus;
    day: DayName;
    isToday: boolean;
  } | null
): string {
  const lines: string[] = [
    `🎓 *${title}*`,
    '━━━━━━━━━━━━━━━━━━━━',
  ];

  if (!data || (!data.current && !data.next)) {
    lines.push('🎉 *No upcoming lectures found on schedule!*');
    lines.push('');
    lines.push('💡 Type `/schedule week` to view the full weekly schedule.');
    return lines.join('\n');
  }

  if (data.current) {
    const c = data.current;
    const endsIn = c.minutesUntilEnd ? formatMinutesDuration(c.minutesUntilEnd) : '';
    lines.push('🟢 *CURRENTLY IN PROGRESS*');
    lines.push('');
    lines.push(`${getClassEmoji(c.type)} *${c.subject}*`);
    lines.push(`⏰ *Time:* ${c.start} – ${c.end}`);
    lines.push(`🏛️ *Room:* ${c.room}`);
    if (endsIn) lines.push(`⏳ *Ends in:* ${endsIn}`);
    lines.push('');
  }

  if (data.next) {
    const n = data.next;
    const dayLabel = data.isToday ? 'Today' : capitalize(data.day);
    lines.push(data.current ? '⏭️ *UP NEXT*' : '🔔 *NEXT UPCOMING LECTURE*');
    lines.push('');
    lines.push(`${getClassEmoji(n.type)} *${n.subject}*`);
    lines.push(`📅 *Day:* ${dayLabel}`);
    lines.push(`⏰ *Time:* ${n.start} – ${n.end}`);
    lines.push(`🏛️ *Room:* ${n.room}`);
    if (data.isToday && n.minutesUntilStart) {
      lines.push(`⏳ *Starts in:* ${formatMinutesDuration(n.minutesUntilStart)}`);
    }
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 Type `/schedule today` or `/schedule remaining` for details.');
  return lines.join('\n');
}

/**
 * Formats remaining lectures for today.
 */
export function formatRemainingView(
  title: string,
  day: DayName,
  remainingClasses: ClassWithStatus[],
  allDone: boolean,
  nextDaySchedule?: { day: DayName; nextClass: any }
): string {
  const lines: string[] = [
    `🎓 *${title}*`,
    `⏳ *Remaining Lectures Today* (${capitalize(day)})`,
    '━━━━━━━━━━━━━━━━━━━━',
    '',
  ];

  if (allDone) {
    lines.push('🎉 *All lectures for today are finished!*');
    lines.push('You are done with classes for today.');
    lines.push('');
    if (nextDaySchedule) {
      const nc = nextDaySchedule.nextClass;
      lines.push('⏭️ *Next lecture on schedule:*');
      lines.push(`📅 *${capitalize(nextDaySchedule.day)}* at *${nc.start}*`);
      lines.push(`📚 *${nc.subject}* (${nc.room})`);
      lines.push('');
    }
    lines.push('💡 Type `/schedule week` to view the full timetable.');
    return lines.join('\n');
  }

  if (remainingClasses.length === 0) {
    lines.push('🎉 *No remaining classes for today!*');
    lines.push('');
    lines.push('💡 Type `/schedule tomorrow` or `/schedule week` to check other days.');
    return lines.join('\n');
  }

  remainingClasses.forEach((c, idx) => {
    lines.push(formatClassCard(c, idx, true));
    lines.push('');
  });

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`📊 *${remainingClasses.length} class${remainingClasses.length === 1 ? '' : 'es'} left for today.*`);
  lines.push('');
  lines.push('💡 Type `/schedule next` to monitor just the next lecture.');
  return lines.join('\n');
}

/**
 * Formats full weekly schedule.
 */
export function formatFullWeekView(data: {
  title: string;
  description?: string;
  days: Array<{ day: DayName; isToday: boolean; classes: ClassWithStatus[] }>;
}): string {
  const lines: string[] = [
    `🎓 *${data.title}*`,
  ];

  if (data.description) {
    lines.push(`📋 _${data.description}_`);
  }
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  let totalWeekClasses = 0;

  data.days.forEach((dayGroup) => {
    const dayLabel = capitalize(dayGroup.day);
    const todayMarker = dayGroup.isToday ? ' 📍 *(Today)*' : '';
    lines.push(`📅 *${dayLabel}*${todayMarker}`);
    lines.push('────────────────────');

    if (dayGroup.classes.length === 0) {
      lines.push('  _No classes_');
    } else {
      dayGroup.classes.forEach((c) => {
        totalWeekClasses++;
        const emoji = getClassEmoji(c.type);
        lines.push(`  ${emoji} *${c.subject}*`);
        lines.push(`     ⏰ ${c.start} – ${c.end} | 🏛️ ${c.room}`);
      });
    }
    lines.push('');
  });

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`📊 *Total Weekly Load:* ${totalWeekClasses} lectures & labs`);
  lines.push('');
  lines.push('💡 *Quick Commands:*');
  lines.push('  `/schedule today`      • Today\'s classes with live status');
  lines.push('  `/schedule next`       • Next upcoming class countdown');
  lines.push('  `/schedule remaining`  • Remaining classes today');
  lines.push('  `/schedule <day>`      • Check any specific day (e.g. `/schedule friday`)');

  return lines.join('\n');
}
