import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import type {
  TimetableConfig,
  RawClassSession,
  ClassSession,
  ClassWithStatus,
  DayName,
} from './schedule-types.js';

const DAY_NAMES_ORDER: DayName[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const DAY_ALIASES: Record<string, DayName> = {
  m: 'monday',
  mon: 'monday',
  monday: 'monday',
  t: 'tuesday',
  tue: 'tuesday',
  tues: 'tuesday',
  tuesday: 'tuesday',
  w: 'wednesday',
  wed: 'wednesday',
  wednesday: 'wednesday',
  th: 'thursday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  thursday: 'thursday',
  f: 'friday',
  fri: 'friday',
  friday: 'friday',
  sat: 'saturday',
  saturday: 'saturday',
  sun: 'sunday',
  sunday: 'sunday',
};

/**
 * Resolves the path to timetable.json:
 * 1. Adjacent to active SQLite DB (e.g. /var/lib/wa-agent/data/timetable.json)
 * 2. ./data/timetable.json in project root
 */
export function getTimetablePath(): string {
  if (config.DATABASE_PATH) {
    const dbDir = path.dirname(config.DATABASE_PATH);
    const candidate = path.join(dbDir, 'timetable.json');
    if (fs.existsSync(candidate)) return candidate;
  }

  const localDataPath = path.resolve(process.cwd(), 'data/timetable.json');
  if (fs.existsSync(localDataPath)) return localDataPath;

  const optDataPath = '/opt/wa-agent/data/timetable.json';
  if (fs.existsSync(optDataPath)) return optDataPath;

  const varDataPath = '/var/lib/wa-agent/data/timetable.json';
  if (fs.existsSync(varDataPath)) return varDataPath;

  return localDataPath;
}

/**
 * Converts a time string like "11:00 AM", "2:30 PM", or "14:00" to minutes from midnight.
 */
export function timeStringToMinutes(str: string): number {
  const clean = str.trim();
  const m = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return 0;

  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();

  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  return hours * 60 + minutes;
}

/**
 * Converts raw class entry to a computed ClassSession.
 */
export function parseClassSession(raw: RawClassSession): ClassSession {
  const startMinutes = timeStringToMinutes(raw.start);
  const endMinutes = timeStringToMinutes(raw.end);
  const durationMinutes = Math.max(0, endMinutes - startMinutes);

  return {
    ...raw,
    startMinutes,
    endMinutes,
    durationMinutes,
  };
}

/**
 * Loads the timetable JSON from disk (hot reloadable — reads fresh on call).
 */
export function loadTimetable(): TimetableConfig {
  const filePath = getTimetablePath();
  if (!fs.existsSync(filePath)) {
    // Return empty fallback config if file doesn't exist yet
    return {
      title: 'University Schedule',
      days: {},
    };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as TimetableConfig;
  } catch (err: any) {
    console.error(`[ScheduleService] Failed to load timetable from ${filePath}:`, err.message);
    return {
      title: 'University Schedule',
      days: {},
    };
  }
}

/**
 * Returns canonical day name from day of week index (0 = Sunday, 1 = Monday).
 */
export function getDayNameFromIndex(dayIndex: number): DayName {
  const map: Record<number, DayName> = {
    0: 'sunday',
    1: 'monday',
    2: 'tuesday',
    3: 'wednesday',
    4: 'thursday',
    5: 'friday',
    6: 'saturday',
  };
  return map[dayIndex] || 'monday';
}

/**
 * Normalizes input string to DayName or resolves relative terms (today, tomorrow).
 */
export function resolveDayName(input?: string, now: Date = new Date()): DayName | null {
  if (!input || !input.trim() || input.trim().toLowerCase() === 'today') {
    return getDayNameFromIndex(now.getDay());
  }

  const clean = input.trim().toLowerCase();

  if (clean === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return getDayNameFromIndex(tomorrow.getDay());
  }

  if (clean === 'yesterday') {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return getDayNameFromIndex(yesterday.getDay());
  }

  return DAY_ALIASES[clean] || null;
}

/**
 * Annotates class sessions with current status (ongoing, upcoming, finished).
 */
export function evaluateClassStatuses(
  classes: ClassSession[],
  isToday: boolean,
  now: Date = new Date()
): ClassWithStatus[] {
  if (!isToday) {
    return classes.map((c) => ({
      ...c,
      status: 'upcoming',
    }));
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  return classes.map((c) => {
    if (currentMinutes >= c.startMinutes && currentMinutes < c.endMinutes) {
      return {
        ...c,
        status: 'ongoing',
        minutesUntilEnd: c.endMinutes - currentMinutes,
      };
    } else if (currentMinutes < c.startMinutes) {
      return {
        ...c,
        status: 'upcoming',
        minutesUntilStart: c.startMinutes - currentMinutes,
      };
    } else {
      return {
        ...c,
        status: 'finished',
      };
    }
  });
}

/**
 * Gets classes for a specific day with real-time status.
 */
export function getDaySchedule(
  day: DayName,
  now: Date = new Date()
): { day: DayName; isToday: boolean; classes: ClassWithStatus[]; title: string } {
  const timetable = loadTimetable();
  const todayName = getDayNameFromIndex(now.getDay());
  const isToday = day === todayName;

  const rawClasses = timetable.days[day] || [];
  const parsedClasses = rawClasses.map(parseClassSession);
  // Sort classes chronologically
  parsedClasses.sort((a, b) => a.startMinutes - b.startMinutes);

  const classesWithStatus = evaluateClassStatuses(parsedClasses, isToday, now);

  return {
    day,
    isToday,
    classes: classesWithStatus,
    title: timetable.title,
  };
}

/**
 * Finds the currently active class and the next upcoming class.
 */
export function getNextLecture(now: Date = new Date()): {
  current?: ClassWithStatus;
  next?: ClassWithStatus;
  day: DayName;
  isToday: boolean;
  title: string;
} | null {
  const timetable = loadTimetable();
  const todayName = getDayNameFromIndex(now.getDay());
  const todaySchedule = getDaySchedule(todayName, now);

  const current = todaySchedule.classes.find((c) => c.status === 'ongoing');
  const nextToday = todaySchedule.classes.find((c) => c.status === 'upcoming');

  if (current || nextToday) {
    return {
      current,
      next: nextToday,
      day: todayName,
      isToday: true,
      title: timetable.title,
    };
  }

  // If no more classes today, find the first class on the next scheduled day
  for (let offset = 1; offset <= 7; offset++) {
    const candidateDate = new Date(now);
    candidateDate.setDate(candidateDate.getDate() + offset);
    const candidateDay = getDayNameFromIndex(candidateDate.getDay());
    const rawClasses = timetable.days[candidateDay] || [];

    if (rawClasses.length > 0) {
      const parsed = rawClasses.map(parseClassSession).sort((a, b) => a.startMinutes - b.startMinutes);
      return {
        next: {
          ...parsed[0],
          status: 'upcoming',
        },
        day: candidateDay,
        isToday: false,
        title: timetable.title,
      };
    }
  }

  return null;
}

/**
 * Gets remaining classes for today (ongoing + upcoming).
 */
export function getRemainingLectures(now: Date = new Date()): {
  day: DayName;
  classes: ClassWithStatus[];
  allDone: boolean;
  nextDaySchedule?: { day: DayName; nextClass: ClassSession };
  title: string;
} {
  const todayName = getDayNameFromIndex(now.getDay());
  const todaySchedule = getDaySchedule(todayName, now);

  const remaining = todaySchedule.classes.filter(
    (c) => c.status === 'ongoing' || c.status === 'upcoming'
  );

  const allDone = todaySchedule.classes.length > 0 && remaining.length === 0;
  let nextDaySchedule: { day: DayName; nextClass: ClassSession } | undefined;

  if (allDone || todaySchedule.classes.length === 0) {
    const nextInfo = getNextLecture(now);
    if (nextInfo?.next && !nextInfo.isToday) {
      nextDaySchedule = {
        day: nextInfo.day,
        nextClass: nextInfo.next,
      };
    }
  }

  return {
    day: todayName,
    classes: remaining,
    allDone,
    nextDaySchedule,
    title: todaySchedule.title,
  };
}

/**
 * Gets full weekly schedule for all active days.
 */
export function getFullWeekSchedule(now: Date = new Date()): {
  title: string;
  description?: string;
  days: Array<{ day: DayName; isToday: boolean; classes: ClassWithStatus[] }>;
} {
  const timetable = loadTimetable();
  const todayName = getDayNameFromIndex(now.getDay());

  const days: Array<{ day: DayName; isToday: boolean; classes: ClassWithStatus[] }> = [];

  for (const day of DAY_NAMES_ORDER) {
    const rawClasses = timetable.days[day];
    if (rawClasses && rawClasses.length > 0) {
      const parsed = rawClasses.map(parseClassSession).sort((a, b) => a.startMinutes - b.startMinutes);
      const isToday = day === todayName;
      days.push({
        day,
        isToday,
        classes: evaluateClassStatuses(parsed, isToday, now),
      });
    }
  }

  return {
    title: timetable.title,
    description: timetable.description,
    days,
  };
}
