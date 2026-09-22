export interface RawClassSession {
  start: string;
  end: string;
  subject: string;
  room: string;
  type?: 'Theory' | 'Lab' | 'Workshop' | string;
}

export interface ClassSession extends RawClassSession {
  startMinutes: number; // Minutes from 00:00 (e.g. 11:00 AM -> 660)
  endMinutes: number;   // Minutes from 00:00 (e.g. 2:00 PM -> 840)
  durationMinutes: number;
}

export type ClassStatus = 'ongoing' | 'upcoming' | 'finished';

export interface ClassWithStatus extends ClassSession {
  status: ClassStatus;
  minutesUntilStart?: number;
  minutesUntilEnd?: number;
}

export interface TimetableConfig {
  title: string;
  description?: string;
  timezone?: string;
  days: Record<string, RawClassSession[]>;
}

export type DayName = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface NextLectureResult {
  current?: ClassWithStatus;
  next?: ClassWithStatus;
  day: DayName;
  isToday: boolean;
  title: string;
  nextLectureDate?: Date;
}
