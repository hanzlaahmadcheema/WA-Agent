/**
 * test/reminders.test.ts
 * Comprehensive test suite for the fully-fledged reminder system:
 * - Second-level precision & compound durations
 * - Specific dates & times with seconds
 * - Daily, Weekly, Monthly, and Interval recurrence
 * - Recurrence advancement & repo management
 * - Interactive snooze & cancel
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase } from '../src/database/connection.js';
import {
  ensureRemindersTable,
  createReminder,
  cancelReminder,
  listPendingReminders,
  getDueReminders,
  markFired,
  advanceRecurringReminder,
  getReminderById,
} from '../src/reminders/reminder-repo.js';
import {
  parseReminder,
  computeNextRecurrence,
  parseTimeOfDay,
  type RecurrenceRule,
} from '../src/reminders/reminder-parser.js';
import {
  formatDistanceToNow,
  formatPreciseCountdown,
  formatDateTimeFull,
} from '../src/reminders/reminder-formatter.js';

const TEST_USER = '923266900001@s.whatsapp.net';

before(() => {
  initDatabase(':memory:');
  ensureRemindersTable();
});

describe('Milestone 7: Comprehensive Reminder System Suite', () => {
  // ─── 7A. Basic Duration Parsing ─────────────────────────────────────────────

  describe('7A. Parser: Relative durations', () => {
    it('parses "30m check build logs"', () => {
      const r = parseReminder('/remind 30m check build logs');
      assert.ok(r);
      assert.ok(r.fireAt > new Date());
      const diffMin = (r.fireAt.getTime() - Date.now()) / 60_000;
      assert.ok(diffMin >= 29 && diffMin <= 31);
      assert.equal(r.message, 'check build logs');
    });

    it('parses "2h review PR"', () => {
      const r = parseReminder('/remind 2h review PR');
      assert.ok(r);
      const diffHr = (r.fireAt.getTime() - Date.now()) / 3_600_000;
      assert.ok(diffHr >= 1.9 && diffHr <= 2.1);
      assert.equal(r.message, 'review PR');
    });

    it('parses "1d deploy to prod"', () => {
      const r = parseReminder('/remind 1d deploy to prod');
      assert.ok(r);
      const diffDay = (r.fireAt.getTime() - Date.now()) / 86_400_000;
      assert.ok(diffDay >= 0.9 && diffDay <= 1.1);
      assert.equal(r.message, 'deploy to prod');
    });
  });

  // ─── 7B. Second-Level Precision & Compound Times ─────────────────────────────

  describe('7B. Parser: Second-level precision & compound durations', () => {
    it('parses 15 seconds precision: "/remind in 15s quick ping"', () => {
      const r = parseReminder('/remind in 15s quick ping');
      assert.ok(r);
      const diffSec = (r.fireAt.getTime() - Date.now()) / 1_000;
      assert.ok(diffSec >= 14 && diffSec <= 16, `Expected ~15s, got ${diffSec}`);
      assert.equal(r.message, 'quick ping');
    });

    it('parses compound duration: "/remind in 1h 30m 15s check server"', () => {
      const r = parseReminder('/remind in 1h 30m 15s check server');
      assert.ok(r);
      const diffSec = (r.fireAt.getTime() - Date.now()) / 1_000;
      const expectedSec = 3600 + 1800 + 15;
      assert.ok(
        Math.abs(diffSec - expectedSec) < 3,
        `Expected ~${expectedSec}s, got ${diffSec}s`
      );
      assert.equal(r.message, 'check server');
    });

    it('parses standalone seconds: "/remind 45sec restart service"', () => {
      const r = parseReminder('/remind 45sec restart service');
      assert.ok(r);
      const diffSec = (r.fireAt.getTime() - Date.now()) / 1_000;
      assert.ok(diffSec >= 44 && diffSec <= 46);
      assert.equal(r.message, 'restart service');
    });
  });

  // ─── 7C. Specific Times with Seconds ────────────────────────────────────────

  describe('7C. Parser: Clock time with seconds', () => {
    it('parses exact time today/tomorrow with seconds: "at 14:30:15 meeting"', () => {
      const r = parseReminder('/remind at 14:30:15 meeting');
      assert.ok(r);
      assert.equal(r.fireAt.getHours(), 14);
      assert.equal(r.fireAt.getMinutes(), 30);
      assert.equal(r.fireAt.getSeconds(), 15);
      assert.equal(r.message, 'meeting');
    });

    it('parses 12-hour AM/PM with seconds: "at 2:15:30 pm client call"', () => {
      const r = parseReminder('/remind at 2:15:30 pm client call');
      assert.ok(r);
      assert.equal(r.fireAt.getHours(), 14);
      assert.equal(r.fireAt.getMinutes(), 15);
      assert.equal(r.fireAt.getSeconds(), 30);
      assert.equal(r.message, 'client call');
    });
  });

  // ─── 7D. Specific Dates with Seconds ────────────────────────────────────────

  describe('7D. Parser: Absolute dates with seconds', () => {
    it('parses ISO date with seconds: "2026-10-25 15:45:30 quarterly review"', () => {
      const r = parseReminder('/remind 2026-10-25 15:45:30 quarterly review');
      assert.ok(r);
      assert.equal(r.fireAt.getFullYear(), 2026);
      assert.equal(r.fireAt.getMonth(), 9); // October is 9
      assert.equal(r.fireAt.getDate(), 25);
      assert.equal(r.fireAt.getHours(), 15);
      assert.equal(r.fireAt.getMinutes(), 45);
      assert.equal(r.fireAt.getSeconds(), 30);
      assert.equal(r.message, 'quarterly review');
    });

    it('parses natural month format with seconds: "25 Oct 2026 15:45:30 project deadline"', () => {
      const r = parseReminder('/remind 25 Oct 2026 15:45:30 project deadline');
      assert.ok(r);
      assert.equal(r.fireAt.getFullYear(), 2026);
      assert.equal(r.fireAt.getMonth(), 9);
      assert.equal(r.fireAt.getDate(), 25);
      assert.equal(r.fireAt.getHours(), 15);
      assert.equal(r.fireAt.getMinutes(), 45);
      assert.equal(r.fireAt.getSeconds(), 30);
      assert.equal(r.message, 'project deadline');
    });
  });

  // ─── 7E. Recurring: Interval ────────────────────────────────────────────────

  describe('7E. Parser: Interval recurrence', () => {
    it('parses "every 30s test ping"', () => {
      const r = parseReminder('/remind every 30s test ping');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'interval');
      assert.equal(r.recurrence.intervalMs, 30_000);
      assert.equal(r.recurrence.humanPattern, 'Every 30 seconds');
      assert.equal(r.message, 'test ping');
    });

    it('parses "every 2h drink water"', () => {
      const r = parseReminder('/remind every 2h drink water');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'interval');
      assert.equal(r.recurrence.intervalMs, 7_200_000);
      assert.equal(r.recurrence.humanPattern, 'Every 2 hours');
      assert.equal(r.message, 'drink water');
    });
  });

  // ─── 7F. Recurring: Daily ───────────────────────────────────────────────────

  describe('7F. Parser: Daily recurrence', () => {
    it('parses "every day at 9am morning standup"', () => {
      const r = parseReminder('/remind every day at 9am morning standup');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'daily');
      assert.equal(r.recurrence.time, '09:00:00');
      assert.equal(r.message, 'morning standup');
      assert.equal(r.fireAt.getHours(), 9);
      assert.equal(r.fireAt.getMinutes(), 0);
    });

    it('parses "daily at 18:30:15 evening workout"', () => {
      const r = parseReminder('/remind daily at 18:30:15 evening workout');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'daily');
      assert.equal(r.recurrence.time, '18:30:15');
      assert.equal(r.message, 'evening workout');
      assert.equal(r.fireAt.getHours(), 18);
      assert.equal(r.fireAt.getMinutes(), 30);
      assert.equal(r.fireAt.getSeconds(), 15);
    });
  });

  // ─── 7G. Recurring: Weekly ──────────────────────────────────────────────────

  describe('7G. Parser: Weekly recurrence', () => {
    it('parses "every monday at 10am sprint planning"', () => {
      const r = parseReminder('/remind every monday at 10am sprint planning');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'weekly');
      assert.deepEqual(r.recurrence.daysOfWeek, [1]);
      assert.equal(r.message, 'sprint planning');
      assert.equal(r.fireAt.getDay(), 1, 'Should fire on a Monday');
    });

    it('parses "weekly on friday at 5pm submit weekly report"', () => {
      const r = parseReminder('/remind weekly on friday at 5pm submit weekly report');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'weekly');
      assert.deepEqual(r.recurrence.daysOfWeek, [5]);
      assert.equal(r.message, 'submit weekly report');
      assert.equal(r.fireAt.getDay(), 5, 'Should fire on a Friday');
    });

    it('parses "every weekday at 9am check emails"', () => {
      const r = parseReminder('/remind every weekday at 9am check emails');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'weekly');
      assert.deepEqual(r.recurrence.daysOfWeek, [1, 2, 3, 4, 5]);
      assert.equal(r.message, 'check emails');
    });
  });

  // ─── 7H. Recurring: Monthly ─────────────────────────────────────────────────

  describe('7H. Parser: Monthly recurrence', () => {
    it('parses "monthly on 1st at 10am pay rent"', () => {
      const r = parseReminder('/remind monthly on 1st at 10am pay rent');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'monthly');
      assert.equal(r.recurrence.dayOfMonth, 1);
      assert.equal(r.recurrence.time, '10:00:00');
      assert.equal(r.message, 'pay rent');
      assert.equal(r.fireAt.getDate(), 1);
    });

    it('parses "every month on the 15th at 9:15:30 credit card payment"', () => {
      const r = parseReminder('/remind every month on the 15th at 9:15:30 credit card payment');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'monthly');
      assert.equal(r.recurrence.dayOfMonth, 15);
      assert.equal(r.recurrence.time, '09:15:30');
      assert.equal(r.message, 'credit card payment');
      assert.equal(r.fireAt.getDate(), 15);
      assert.equal(r.fireAt.getHours(), 9);
      assert.equal(r.fireAt.getMinutes(), 15);
      assert.equal(r.fireAt.getSeconds(), 30);
    });
  });

  // ─── 7I. Embedded Natural Speech ────────────────────────────────────────────

  describe('7I. Parser: Embedded phrasing', () => {
    it('parses "remind me to push release at 5pm"', () => {
      const r = parseReminder('remind me to push release at 5pm');
      assert.ok(r);
      assert.ok(r.message.includes('push release'));
      assert.equal(r.fireAt.getHours(), 17);
    });

    it('parses "drink water every 2h" with natural prefix', () => {
      const r = parseReminder('remind me to drink water every 2h');
      assert.ok(r);
      assert.ok(r.recurrence);
      assert.equal(r.recurrence.type, 'interval');
      assert.equal(r.message, 'drink water');
    });

    it('parses "check logs in 45s"', () => {
      const r = parseReminder('remind me to check logs in 45s');
      assert.ok(r);
      assert.equal(r.message, 'check logs');
      const diffSec = (r.fireAt.getTime() - Date.now()) / 1_000;
      assert.ok(diffSec >= 44 && diffSec <= 46);
    });
  });

  // ─── 7J. Recurrence Progression Math ────────────────────────────────────────

  describe('7J. Recurrence: computeNextRecurrence math', () => {
    it('advances daily recurrence by 24h', () => {
      const rule: RecurrenceRule = {
        type: 'daily',
        time: '10:00:00',
        humanPattern: 'Daily at 10:00:00',
      };
      const base = new Date(2026, 8, 15, 10, 0, 0); // Sep 15 10:00
      const next = computeNextRecurrence(rule, base);
      assert.equal(next.getFullYear(), 2026);
      assert.equal(next.getMonth(), 8);
      assert.equal(next.getDate(), 16);
      assert.equal(next.getHours(), 10);
    });

    it('advances weekly recurrence to next target day', () => {
      const rule: RecurrenceRule = {
        type: 'weekly',
        daysOfWeek: [1], // Monday
        time: '09:00:00',
        humanPattern: 'Weekly on Monday',
      };
      const base = new Date(2026, 8, 14, 9, 0, 0); // Sep 14 was Monday
      const next = computeNextRecurrence(rule, base);
      assert.equal(next.getDate(), 21, 'Should advance by 7 days to next Monday');
    });

    it('advances monthly recurrence to next month on target day', () => {
      const rule: RecurrenceRule = {
        type: 'monthly',
        dayOfMonth: 1,
        time: '10:00:00',
        humanPattern: 'Monthly on 1st',
      };
      const base = new Date(2026, 8, 1, 10, 0, 0); // Sep 1
      const next = computeNextRecurrence(rule, base);
      assert.equal(next.getMonth(), 9, 'Should advance to October');
      assert.equal(next.getDate(), 1);
    });
  });

  // ─── 7K. Formatter ──────────────────────────────────────────────────────────

  describe('7K. Formatter: precision & countdowns', () => {
    it('formats seconds', () => {
      const d = new Date(Date.now() + 30_000);
      const result = formatDistanceToNow(d);
      assert.ok(/^(2[89]|30) seconds?$/.test(result), `Got: ${result}`);
    });

    it('formats precise countdown: "1h 30m 15s"', () => {
      const d = new Date(Date.now() + (3600 + 1800 + 15) * 1000);
      const str = formatPreciseCountdown(d);
      assert.ok(str.includes('1h'), `Expected 1h in ${str}`);
      assert.ok(str.includes('30m'), `Expected 30m in ${str}`);
    });

    it('formats full timestamp with seconds: formatDateTimeFull', () => {
      const d = new Date(2026, 8, 15, 14, 30, 15);
      const str = formatDateTimeFull(d);
      assert.ok(str.includes('14:30:15') || str.includes('2:30:15'));
      assert.ok(str.includes('2026'));
    });
  });

  // ─── 7L. Repository: Recurrence CRUD & Lifecycle ────────────────────────────

  describe('7L. Repository: Recurrence CRUD and Advancement', () => {
    it('creates and persists a recurring reminder with recurrence fields', () => {
      const rule: RecurrenceRule = {
        type: 'daily',
        time: '09:00:00',
        humanPattern: 'Daily at 09:00:00',
      };
      const fireAt = new Date(Date.now() + 3_600_000);
      const r = createReminder(TEST_USER, 'standup meeting', fireAt, rule);

      assert.ok(r.id > 0);
      assert.equal(r.recurrence_type, 'daily');
      assert.ok(r.recurrence_rule);
      assert.equal(r.status, 'pending');

      const fetched = getReminderById(r.id);
      assert.ok(fetched);
      assert.equal(fetched.recurrence_type, 'daily');
      assert.equal(fetched.message, 'standup meeting');
    });

    it('advances a recurring reminder on fire without marking it fired', () => {
      const fireAt = new Date(Date.now() - 1000);
      const r = createReminder(TEST_USER, 'ping server', fireAt, {
        type: 'interval',
        intervalMs: 60_000,
        humanPattern: 'Every 1 minute',
      });

      const nextFire = Date.now() + 60_000;
      advanceRecurringReminder(r.id, nextFire);

      const updated = getReminderById(r.id);
      assert.ok(updated);
      assert.equal(updated.status, 'pending', 'Status should remain pending');
      assert.equal(updated.fire_at, nextFire);
      assert.ok(updated.last_fired_at! > 0, 'last_fired_at should be recorded');
    });

    it('cancels a recurring reminder', () => {
      const r = createReminder(TEST_USER, 'weekly sync', new Date(Date.now() + 100_000), {
        type: 'weekly',
        daysOfWeek: [1],
        time: '10:00:00',
        humanPattern: 'Weekly on Monday',
      });

      const ok = cancelReminder(r.id, TEST_USER);
      assert.ok(ok);

      const updated = getReminderById(r.id);
      assert.ok(updated);
      assert.equal(updated.status, 'cancelled');
    });
  });
});
