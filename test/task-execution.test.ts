import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { config } from '../src/config.js';
import { setJobNotificationHandler } from '../src/jobs/job-manager.js';

const TEST_DB = path.resolve('./data/test_task_plane.db');
const TEST_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;

test('Task Execution & Background Job FSM Suite', async (t) => {
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }

  initDatabase(TEST_DB);

  // Setup: create active session
  await processIncomingMessage(TEST_JID, '/session new async-test');

  await t.test('1. Reject /run when no instruction provided', async () => {
    const res = await processIncomingMessage(TEST_JID, '/run');
    assert.match(res!, /ERR_INVALID_ARG/);
  });

  await t.test('2. List empty jobs', async () => {
    const res = await processIncomingMessage(TEST_JID, '/jobs');
    assert.match(res!, /No recent tasks found/);
  });

  await t.test('3. Query non-existent job returns ERR_NOT_FOUND', async () => {
    const res = await processIncomingMessage(TEST_JID, '/job 9999');
    assert.match(res!, /ERR_NOT_FOUND/);
  });

  closeDatabase();
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }
});
