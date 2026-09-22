/**
 * test/schedule.test.ts
 * Comprehensive test suite for Public University Timetable System & Access Control:
 * - Time string parsing & minute conversions
 * - Day name resolution (today, tomorrow, mon..fri)
 * - Class session status evaluation (ongoing, upcoming, finished)
 * - Next lecture detection & remaining lectures filtering
 * - Whole week timetable formatting
 * - WhatsApp markdown presentation formatting
 * - Pipeline authorization: Public commands allowed for all, protected commands blocked
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../src/database/connection.js';
import { ensureRemindersTable, listPendingReminders } from '../src/reminders/reminder-repo.js';
import { parseDurationToMinutes } from '../src/commands/schedule.cmd.js';
import {
  timeStringToMinutes,
  loadTimetable,
  resolveDayName,
  getDayNameFromIndex,
  getDaySchedule,
  getNextLecture,
  getRemainingLectures,
  getFullWeekSchedule,
} from '../src/schedule/schedule-service.js';
import {
  capitalize,
  formatMinutesDuration,
  formatDayView,
  formatNextLectureView,
  formatRemainingView,
  formatFullWeekView,
} from '../src/schedule/schedule-formatter.js';
import { executeMessagePipeline, isPublicCommandText } from '../src/whatsapp/message-pipeline.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { clearAdminLids } from '../src/security/authorizer.js';
import { config } from '../src/config.js';
import type { proto } from '@whiskeysockets/baileys';

const TEST_DB = path.resolve('./data/test_schedule.db');
const STRANGER_JID = '923999999999@s.whatsapp.net';
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;

before(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);
  ensureRemindersTable();
});

after(() => {
  clearAdminLids();
  closeDatabase();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe('University Timetable & Public Command System', () => {
  // Helper to create a specific Date on a Monday
  function createMockDate(dayIndex: number, hours: number, minutes: number): Date {
    // 2026-09-21 was a Monday (dayIndex 1)
    // 2026-09-22 was a Tuesday (dayIndex 2)
    // 2026-09-25 was a Friday (dayIndex 5)
    const baseDay = 20 + dayIndex;
    return new Date(2026, 8, baseDay, hours, minutes, 0);
  }

  // ─── 1. Time Arithmetic & Minutes Conversion ─────────────────────────────────
  describe('1. Time Arithmetic & Minutes Calculation', () => {
    it('converts 12-hour AM/PM time strings to minutes from midnight', () => {
      assert.equal(timeStringToMinutes('8:00 AM'), 8 * 60);
      assert.equal(timeStringToMinutes('11:00 AM'), 11 * 60);
      assert.equal(timeStringToMinutes('12:00 PM'), 12 * 60);
      assert.equal(timeStringToMinutes('12:30 PM'), 12 * 60 + 30);
      assert.equal(timeStringToMinutes('2:00 PM'), 14 * 60);
      assert.equal(timeStringToMinutes('2:30 PM'), 14 * 60 + 30);
      assert.equal(timeStringToMinutes('4:30 PM'), 16 * 60 + 30);
      assert.equal(timeStringToMinutes('5:00 PM'), 17 * 60);
    });

    it('formats duration in minutes into human-readable strings', () => {
      assert.equal(formatMinutesDuration(0), 'now');
      assert.equal(formatMinutesDuration(15), '15m');
      assert.equal(formatMinutesDuration(60), '1h');
      assert.equal(formatMinutesDuration(75), '1h 15m');
      assert.equal(formatMinutesDuration(180), '3h');
      assert.equal(formatMinutesDuration(190), '3h 10m');
    });

    it('capitalizes strings properly', () => {
      assert.equal(capitalize('monday'), 'Monday');
      assert.equal(capitalize('friday'), 'Friday');
    });

    it('parses reminder duration strings to minutes', () => {
      assert.equal(parseDurationToMinutes('15min'), 15);
      assert.equal(parseDurationToMinutes('15m'), 15);
      assert.equal(parseDurationToMinutes('15 min'), 15);
      assert.equal(parseDurationToMinutes('30 mins'), 30);
      assert.equal(parseDurationToMinutes('1h'), 60);
      assert.equal(parseDurationToMinutes('1h 15m'), 75);
      assert.equal(parseDurationToMinutes('10'), 10);
      assert.equal(parseDurationToMinutes('15min before'), 15);
      assert.equal(parseDurationToMinutes('invalid'), null);
    });
  });

  // ─── 2. Day Resolution ───────────────────────────────────────────────────────
  describe('2. Day Resolution', () => {
    it('resolves day aliases to canonical day names', () => {
      assert.equal(resolveDayName('monday'), 'monday');
      assert.equal(resolveDayName('mon'), 'monday');
      assert.equal(resolveDayName('m'), 'monday');
      assert.equal(resolveDayName('tuesday'), 'tuesday');
      assert.equal(resolveDayName('tue'), 'tuesday');
      assert.equal(resolveDayName('wednesday'), 'wednesday');
      assert.equal(resolveDayName('wed'), 'wednesday');
      assert.equal(resolveDayName('thursday'), 'thursday');
      assert.equal(resolveDayName('thu'), 'thursday');
      assert.equal(resolveDayName('friday'), 'friday');
      assert.equal(resolveDayName('fri'), 'friday');
    });

    it('resolves relative days (today, tomorrow)', () => {
      const monday = createMockDate(1, 10, 0);
      assert.equal(resolveDayName('today', monday), 'monday');
      assert.equal(resolveDayName('tomorrow', monday), 'tuesday');
      assert.equal(resolveDayName(undefined, monday), 'monday');
    });

    it('returns null for unknown day strings', () => {
      assert.equal(resolveDayName('someday'), null);
      assert.equal(resolveDayName('xyz'), null);
    });
  });

  // ─── 3. Schedule Service Engine ──────────────────────────────────────────────
  describe('3. Schedule Service Engine & Queries', () => {
    it('loads timetable from JSON configuration file without hardcoding', () => {
      const cfg = loadTimetable();
      assert.ok(cfg.title.includes('BSCS-6 (6A)'));
      assert.ok(cfg.days.monday && cfg.days.monday.length >= 2);
      assert.ok(cfg.days.tuesday && cfg.days.tuesday.length >= 3);
      assert.ok(cfg.days.wednesday && cfg.days.wednesday.length >= 2);
      assert.ok(cfg.days.thursday && cfg.days.thursday.length >= 3);
      assert.ok(cfg.days.friday && cfg.days.friday.length >= 2);
    });

    it('retrieves Monday schedule with proper statuses based on mock time', () => {
      // Monday classes:
      // 11:00 AM - 2:00 PM (PDC Lab)
      // 2:00 PM - 4:00 PM (Computer Networks)

      // Time: 10:00 AM on Monday -> Both upcoming
      const morning = getDaySchedule('monday', createMockDate(1, 10, 0));
      assert.equal(morning.classes[0].status, 'upcoming');
      assert.equal(morning.classes[1].status, 'upcoming');

      // Time: 12:00 PM on Monday -> First ongoing, second upcoming
      const noon = getDaySchedule('monday', createMockDate(1, 12, 0));
      assert.equal(noon.classes[0].status, 'ongoing');
      assert.equal(noon.classes[1].status, 'upcoming');

      // Time: 3:00 PM on Monday -> First finished, second ongoing
      const afternoon = getDaySchedule('monday', createMockDate(1, 15, 0));
      assert.equal(afternoon.classes[0].status, 'finished');
      assert.equal(afternoon.classes[1].status, 'ongoing');

      // Time: 5:00 PM on Monday -> Both finished
      const evening = getDaySchedule('monday', createMockDate(1, 17, 0));
      assert.equal(evening.classes[0].status, 'finished');
      assert.equal(evening.classes[1].status, 'finished');
    });

    it('detects next lecture accurately with countdown', () => {
      // On Monday at 10:15 AM, next lecture is PDC Lab starting at 11:00 AM (45 min left)
      const res = getNextLecture(createMockDate(1, 10, 15));
      assert.ok(res);
      assert.ok(res.next);
      assert.equal(res.next.subject, 'Parallel & Distributed Computing Lab');
      assert.equal(res.next.minutesUntilStart, 45);

      // On Monday at 12:00 PM, first class is ongoing, next class is Computer Networks (120 min left)
      const res2 = getNextLecture(createMockDate(1, 12, 0));
      assert.ok(res2);
      assert.ok(res2.current);
      assert.equal(res2.current.subject, 'Parallel & Distributed Computing Lab');
      assert.ok(res2.next);
      assert.equal(res2.next.subject, 'Computer Networks');
      assert.equal(res2.next.minutesUntilStart, 120);

      // After all classes end on Monday at 5:00 PM, next class is on Tuesday morning
      const res3 = getNextLecture(createMockDate(1, 17, 0));
      assert.ok(res3);
      assert.equal(res3.current, undefined);
      assert.ok(res3.next);
      assert.equal(res3.day, 'tuesday');
      assert.equal(res3.isToday, false);
    });

    it('filters remaining lectures (ongoing + upcoming)', () => {
      // On Tuesday at 10:00 AM:
      // 8:00 AM - 11:00 AM (ongoing)
      // 12:30 PM - 2:30 PM (upcoming)
      // 2:30 PM - 4:30 PM (upcoming)
      const remaining = getRemainingLectures(createMockDate(2, 10, 0));
      assert.equal(remaining.classes.length, 3);
      assert.equal(remaining.classes[0].status, 'ongoing');
      assert.equal(remaining.classes[1].status, 'upcoming');
      assert.equal(remaining.classes[2].status, 'upcoming');

      // On Tuesday at 1:00 PM:
      // 8:00 AM - 11:00 AM is finished
      // 12:30 PM - 2:30 PM is ongoing
      // 2:30 PM - 4:30 PM is upcoming
      const remainingAfternoon = getRemainingLectures(createMockDate(2, 13, 0));
      assert.equal(remainingAfternoon.classes.length, 2);
      assert.equal(remainingAfternoon.classes[0].subject, 'Advance Database Management Systems');
      assert.equal(remainingAfternoon.classes[1].subject, 'Parallel & Distributed Computing');
    });

    it('returns full week schedule with all working days', () => {
      const week = getFullWeekSchedule();
      assert.ok(week.days.length >= 5);
      const days = week.days.map((d) => d.day);
      assert.ok(days.includes('monday'));
      assert.ok(days.includes('tuesday'));
      assert.ok(days.includes('wednesday'));
      assert.ok(days.includes('thursday'));
      assert.ok(days.includes('friday'));
    });
  });

  // ─── 4. WhatsApp Presentation Formatting ─────────────────────────────────────
  describe('4. WhatsApp Presentation Formatting', () => {
    it('formats day schedule with header, emojis, and room info', () => {
      const res = getDaySchedule('monday', createMockDate(1, 10, 0));
      const output = formatDayView(res.title, res.day, res.classes, res.isToday, createMockDate(1, 10, 0));
      assert.match(output, /BSCS-6 \(6A\)/);
      assert.match(output, /Monday Schedule/);
      assert.match(output, /Computer Lab 3/);
      assert.match(output, /Classroom 11/);
    });

    it('formats next lecture card with live countdown', () => {
      const res = getNextLecture(createMockDate(1, 10, 15));
      assert.ok(res);
      const output = formatNextLectureView(res.title, res);
      assert.match(output, /NEXT UPCOMING LECTURE/);
      assert.match(output, /Parallel & Distributed Computing Lab/);
      assert.match(output, /Computer Lab 3/);
      assert.match(output, /Starts in:\* 45m/);
    });

    it('formats full week schedule with day dividers and total load', () => {
      const week = getFullWeekSchedule();
      const output = formatFullWeekView(week);
      assert.match(output, /BSCS-6 \(6A\)/);
      assert.match(output, /Monday/);
      assert.match(output, /Tuesday/);
      assert.match(output, /Wednesday/);
      assert.match(output, /Thursday/);
      assert.match(output, /Friday/);
      assert.match(output, /Total Weekly Load/);
    });
  });

  // ─── 5. Command Router Execution ─────────────────────────────────────────────
  describe('5. Command Router Execution & Handlers', () => {
    it('executes /schedule week', async () => {
      const output = await processIncomingMessage(ADMIN_JID, '/schedule week');
      assert.ok(typeof output === 'string');
      assert.match(output, /BSCS-6 \(6A\)/);
      assert.match(output, /Monday/);
      assert.match(output, /Friday/);
    });

    it('executes /schedule monday and /schedule friday', async () => {
      const mon = await processIncomingMessage(ADMIN_JID, '/schedule monday');
      assert.ok(typeof mon === 'string');
      assert.match(mon, /Monday Schedule/);
      assert.match(mon, /Computer Lab 3/);

      const fri = await processIncomingMessage(ADMIN_JID, '/schedule friday');
      assert.ok(typeof fri === 'string');
      assert.match(fri, /Friday Schedule/);
      assert.match(fri, /Advance Database Management Systems Lab/);
    });

    it('executes /schedule next and /schedule remaining', async () => {
      const next = await processIncomingMessage(ADMIN_JID, '/schedule next');
      assert.ok(typeof next === 'string');
      assert.match(next, /LECTURE/);

      const rem = await processIncomingMessage(ADMIN_JID, '/schedule remaining');
      assert.ok(typeof rem === 'string');
      assert.match(rem, /Lectures Today/);
    });

    it('handles shorthand alias /tt and /classes', async () => {
      const tt = await processIncomingMessage(ADMIN_JID, '/tt week');
      assert.ok(typeof tt === 'string');
      assert.match(tt, /BSCS-6 \(6A\)/);

      const cls = await processIncomingMessage(ADMIN_JID, '/classes friday');
      assert.ok(typeof cls === 'string');
      assert.match(cls, /Friday Schedule/);
    });

    it('schedules a reminder before next lecture with /schedule remind 15min', async () => {
      const output = await processIncomingMessage(ADMIN_JID, '/schedule remind 15min');
      assert.ok(typeof output === 'string');
      assert.match(output, /Lecture Reminder Scheduled/);
      assert.match(output, /15m before class/);
      assert.match(output, /Room/);

      // Verify stored in database
      const pending = listPendingReminders(ADMIN_JID);
      assert.ok(pending.length >= 1);
      const lectureRem = pending.find((r) => r.message.includes('Upcoming Lecture Alert!'));
      assert.ok(lectureRem);
      assert.match(lectureRem.message, /Upcoming Lecture Alert/);
    });
  });

  // ─── 6. Public Accessibility & Security Boundaries ───────────────────────────
  describe('6. Public Accessibility & Strict Control Plane Protection', () => {
    it('identifies public commands correctly via isPublicCommandText', () => {
      assert.equal(isPublicCommandText('/schedule'), true);
      assert.equal(isPublicCommandText('/schedule week'), true);
      assert.equal(isPublicCommandText('/schedule next'), true);
      assert.equal(isPublicCommandText('/tt next'), true);
      assert.equal(isPublicCommandText('/classes friday'), true);
      assert.equal(isPublicCommandText('schedule tomorrow'), true);
      assert.equal(isPublicCommandText('tt'), true);
      assert.equal(isPublicCommandText('/remind 30m Check logs'), true);
      assert.equal(isPublicCommandText('remind me tomorrow at 9am call'), true);
      assert.equal(isPublicCommandText('/reminders'), true);
      assert.equal(isPublicCommandText('/ping'), true);
      assert.equal(isPublicCommandText('ping'), true);
      assert.equal(isPublicCommandText('/time'), true);
      assert.equal(isPublicCommandText('11'), true);
      assert.equal(isPublicCommandText('12'), true);

      // Protected commands MUST NOT be public
      assert.equal(isPublicCommandText('/run whoami'), false);
      assert.equal(isPublicCommandText('/ls'), false);
      assert.equal(isPublicCommandText('/cd /etc'), false);
      assert.equal(isPublicCommandText('/git status'), false);
      assert.equal(isPublicCommandText('/session new test'), false);
      assert.equal(isPublicCommandText('/project new test'), false);
    });

    it('allows stranger (unauthorized user) to query /schedule', async () => {
      const msg: proto.IWebMessageInfo = {
        key: {
          id: 'PUBLIC_SCHED_1',
          remoteJid: STRANGER_JID,
          fromMe: false,
        },
        message: {
          conversation: '/schedule week',
        },
      };

      const res = await executeMessagePipeline(msg);
      assert.equal(res.shouldReply, true);
      assert.equal(res.isUnauthorized, undefined);
      assert.match(res.replyText!, /BSCS-6 \(6A\)/);
      assert.match(res.replyText!, /Monday/);
      assert.match(res.replyText!, /Friday/);
    });

    it('allows stranger (unauthorized user) to set a reminder', async () => {
      const msg: proto.IWebMessageInfo = {
        key: {
          id: 'PUBLIC_REMIND_1',
          remoteJid: STRANGER_JID,
          fromMe: false,
        },
        message: {
          conversation: '/remind in 1h Check assignment deadline',
        },
      };

      const res = await executeMessagePipeline(msg);
      assert.equal(res.shouldReply, true);
      assert.equal(res.isUnauthorized, undefined);
      assert.match(res.replyText!, /Reminder Scheduled/);
      assert.match(res.replyText!, /Check assignment deadline/);
    });

    it('allows stranger (unauthorized user) to set lecture reminder with /schedule remind 15min', async () => {
      const remindMsg: proto.IWebMessageInfo = {
        key: { id: 'STRANGER_SCHED_REMIND', remoteJid: STRANGER_JID, fromMe: false },
        message: { conversation: '/schedule remind 15min' },
      };
      const res = await executeMessagePipeline(remindMsg);
      assert.equal(res.shouldReply, true);
      assert.equal(res.isUnauthorized, undefined);
      assert.match(res.replyText!, /Lecture Reminder Scheduled/);
      assert.match(res.replyText!, /15m before class/);

      // Verify stored in database for stranger
      const pending = listPendingReminders(STRANGER_JID);
      const rem = pending.find((r) => r.message.includes('Upcoming Lecture Alert!'));
      assert.ok(rem);
    });

    it('allows stranger (unauthorized user) to ping or query server time', async () => {
      const pingMsg: proto.IWebMessageInfo = {
        key: { id: 'PUBLIC_PING_1', remoteJid: STRANGER_JID, fromMe: false },
        message: { conversation: '/ping' },
      };
      const pingRes = await executeMessagePipeline(pingMsg);
      assert.equal(pingRes.shouldReply, true);
      assert.match(pingRes.replyText!, /Pong!/);

      const timeMsg: proto.IWebMessageInfo = {
        key: { id: 'PUBLIC_TIME_1', remoteJid: STRANGER_JID, fromMe: false },
        message: { conversation: '/time' },
      };
      const timeRes = await executeMessagePipeline(timeMsg);
      assert.equal(timeRes.shouldReply, true);
      assert.match(timeRes.replyText!, /Current Local Time/);
    });

    it('strictly denies stranger from accessing /run or bash commands', async () => {
      const runMsg: proto.IWebMessageInfo = {
        key: {
          id: 'UNAUTH_RUN_ATTEMPT',
          remoteJid: STRANGER_JID,
          fromMe: false,
        },
        message: {
          conversation: '/run whoami',
        },
      };

      const res = await executeMessagePipeline(runMsg);
      assert.equal(res.shouldReply, true);
      assert.equal(res.isUnauthorized, true);
      assert.equal(res.replyText, '🛑 *Access Denied*: Unauthorized sender.');
    });

    it('strictly denies stranger from accessing filesystem / navigation commands', async () => {
      const lsMsg: proto.IWebMessageInfo = {
        key: {
          id: 'UNAUTH_LS_ATTEMPT',
          remoteJid: STRANGER_JID,
          fromMe: false,
        },
        message: {
          conversation: '/ls',
        },
      };

      const res = await executeMessagePipeline(lsMsg);
      assert.equal(res.shouldReply, true);
      assert.equal(res.isUnauthorized, true);
      assert.equal(res.replyText, '🛑 *Access Denied*: Unauthorized sender.');
    });

    it('echoes ":Hello" directly for any sender', async () => {
      const echoMsg: proto.IWebMessageInfo = {
        key: { id: 'ECHO_MSG_1', remoteJid: STRANGER_JID, fromMe: false },
        message: { conversation: ':Hello' },
      };

      const res = await executeMessagePipeline(echoMsg);
      assert.equal(res.shouldReply, true);
      assert.equal(res.replyText, 'Hello');
    });

    it('replies "Hello" to friendly greetings without dumping menu', async () => {
      const greetMsg: proto.IWebMessageInfo = {
        key: { id: 'GREET_MSG_1', remoteJid: STRANGER_JID, fromMe: false },
        message: { conversation: 'Hello' },
      };

      const res = await executeMessagePipeline(greetMsg);
      assert.equal(res.shouldReply, true);
      assert.equal(res.replyText, 'Hello');
    });
  });
});
