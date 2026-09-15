/**
 * test/reminders.test.ts
 * Tests for the reminder system — parser, repo, command handler, and scheduler.
 * No AI/agent involved — pure bot-side logic.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase } from '../src/database/connection.js';
import { ensureRemindersTable, createReminder, cancelReminder, listPendingReminders, getDueReminders, markFired } from '../src/reminders/reminder-repo.js';
import { parseReminder } from '../src/reminders/reminder-parser.js';
import { formatDistanceToNow } from '../src/reminders/reminder-formatter.js';

const TEST_USER = '923266900001@s.whatsapp.net';

before(() => {
  initDatabase(':memory:');
  ensureRemindersTable();
});

describe('Milestone 7: Reminder System Suite', () => {
  // ─── Parser ──────────────────────────────────────────────────────────────────

  describe('7A. Parser: /remind duration', () => {
    it('parses "30m check build logs"', () => {
      const r = parseReminder('/remind 30m check build logs');
      assert.ok(r, 'Should parse');
      assert.ok(r!.fireAt > new Date(), 'fireAt should be in the future');
      const diffMin = (r!.fireAt.getTime() - Date.now()) / 60_000;
      assert.ok(diffMin >= 29 && diffMin <= 31, `Expected ~30m, got ${diffMin.toFixed(1)}m`);
      assert.equal(r!.message, 'check build logs');
    });

    it('parses "2h review PR"', () => {
      const r = parseReminder('/remind 2h review PR');
      assert.ok(r);
      const diffHr = (r!.fireAt.getTime() - Date.now()) / 3_600_000;
      assert.ok(diffHr >= 1.9 && diffHr <= 2.1, `Expected ~2h`);
      assert.equal(r!.message, 'review PR');
    });

    it('parses "1d deploy to prod"', () => {
      const r = parseReminder('/remind 1d deploy to prod');
      assert.ok(r);
      const diffDay = (r!.fireAt.getTime() - Date.now()) / 86_400_000;
      assert.ok(diffDay >= 0.9 && diffDay <= 1.1);
      assert.equal(r!.message, 'deploy to prod');
    });
  });

  describe('7B. Parser: "remind me" natural language', () => {
    it('parses "remind me to push at 5pm"', () => {
      const r = parseReminder('remind me to push at 5pm');
      assert.ok(r, 'Should parse natural language');
      assert.ok(r!.fireAt > new Date(), 'Should be future');
      // message is whatever comes before the time token
      assert.ok(r!.message.length > 0, 'Message should not be empty');
    });

    it('parses "remind me 30m standup"', () => {
      const r = parseReminder('remind me 30m standup');
      assert.ok(r);
      assert.equal(r!.message, 'standup');
    });

    it('returns null for non-reminder text', () => {
      assert.equal(parseReminder('hello world'), null);
      assert.equal(parseReminder('/run fix the bug'), null);
    });
  });

  describe('7C. Parser: tomorrow', () => {
    it('parses "remind me tomorrow 9am standup"', () => {
      const r = parseReminder('remind me tomorrow 9am standup');
      assert.ok(r);
      const fireDate = r!.fireAt;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      assert.equal(fireDate.getDate(), tomorrow.getDate(), 'Should be tomorrow');
      assert.equal(fireDate.getHours(), 9);
      assert.equal(r!.message, 'standup');
    });
  });

  // ─── Formatter ───────────────────────────────────────────────────────────────

  describe('7D. Formatter: formatDistanceToNow', () => {
    it('formats seconds', () => {
      const d = new Date(Date.now() + 30_000);
      const result = formatDistanceToNow(d);
      // Allow 28-30 due to timing
      assert.ok(/^(2[89]|30) seconds?$/.test(result), `Got: ${result}`);
    });

    it('formats 1 minute', () => {
      const d = new Date(Date.now() + 60_000);
      assert.equal(formatDistanceToNow(d), '1 minute');
    });

    it('formats hours', () => {
      const d = new Date(Date.now() + 7_200_000);
      assert.equal(formatDistanceToNow(d), '2 hours');
    });

    it('formats days', () => {
      const d = new Date(Date.now() + 86_400_000);
      assert.equal(formatDistanceToNow(d), '1 day');
    });
  });

  // ─── Repository ──────────────────────────────────────────────────────────────

  describe('7E. Repository: CRUD', () => {
    it('creates a reminder and lists it as pending', () => {
      const fireAt = new Date(Date.now() + 3_600_000); // 1h from now
      const r = createReminder(TEST_USER, 'test message', fireAt);
      assert.ok(r.id > 0);
      assert.equal(r.status, 'pending');

      const list = listPendingReminders(TEST_USER);
      assert.ok(list.some((x) => x.id === r.id));
    });

    it('cancels a reminder', () => {
      const r = createReminder(TEST_USER, 'to be cancelled', new Date(Date.now() + 60_000));
      const ok = cancelReminder(r.id, TEST_USER);
      assert.ok(ok);
      const list = listPendingReminders(TEST_USER);
      assert.ok(!list.some((x) => x.id === r.id));
    });

    it('returns due reminders', () => {
      const fireAt = new Date(Date.now() - 1000); // 1s ago (already due)
      const r = createReminder(TEST_USER, 'overdue reminder', fireAt);
      const due = getDueReminders();
      assert.ok(due.some((x) => x.id === r.id), 'Should appear in due list');
    });

    it('marks reminder as fired', () => {
      const r = createReminder(TEST_USER, 'will be fired', new Date(Date.now() - 1000));
      markFired(r.id);
      const due = getDueReminders();
      assert.ok(!due.some((x) => x.id === r.id), 'Fired reminder should not appear again');
    });
  });
});
