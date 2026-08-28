import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { config } from '../src/config.js';

const TEST_DB = path.resolve('./data/test_control_plane.db');
const TEST_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;

test('WhatsApp Control Plane Integration Suite', async (t) => {
  // Clean up previous test db
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }

  initDatabase(TEST_DB);

  await t.test('1. Unauthorized user rejection', async () => {
    const res = await processIncomingMessage('9999999999@s.whatsapp.net', '/pwd', 'Hacker');
    assert.match(res!, /ERR_UNAUTHORIZED/);
  });

  await t.test('2. Admin authorization & /menu', async () => {
    const res = await processIncomingMessage(TEST_JID, '/menu', 'Admin');
    assert.match(res!, /Claude Automation Control Plane/);
    assert.match(res!, /Navigation/);
  });

  await t.test('3. Navigation: cd into WA-Agent & /pwd & /ls', async () => {
    const cdRes = await processIncomingMessage(TEST_JID, '/cd WA-Agent');
    assert.match(cdRes!, /WA-Agent/);

    const pwdRes = await processIncomingMessage(TEST_JID, '/pwd');
    assert.match(pwdRes!, /WA-Agent/);

    const lsRes = await processIncomingMessage(TEST_JID, '/ls');
    assert.match(lsRes!, /package\.json/);
    assert.match(lsRes!, /tsconfig\.json/);
  });

  await t.test('4. Numbered navigation: select index to view file', async () => {
    // 1. Run /ls to populate selection cache inside WA-Agent
    const lsRes = await processIncomingMessage(TEST_JID, '/ls');
    assert.match(lsRes!, /package\.json/);

    // Find the number for package.json
    const match = lsRes!.match(/(\d+)\.\s+📄\s+package\.json/);
    assert.ok(match, 'package.json should have a numbered index');
    const pkgIndex = match[1];

    // 2. View file using numeric index: /view <index>
    const viewRes = await processIncomingMessage(TEST_JID, `/view ${pkgIndex}`);
    assert.match(viewRes!, /package\.json/);
    assert.match(viewRes!, /"name": "wa-agent"/);
  });

  await t.test('5. Sandbox path traversal protection', async () => {
    const badRes = await processIncomingMessage(TEST_JID, '/cd /etc');
    assert.match(badRes!, /ERR_SANDBOX_VIOLATION/);
  });

  await t.test('6. Session lifecycle (/session new, list, close)', async () => {
    const newRes = await processIncomingMessage(TEST_JID, '/session new test-session');
    assert.match(newRes!, /New Session Created/);
    assert.match(newRes!, /test-session/);

    const listRes = await processIncomingMessage(TEST_JID, '/session list');
    assert.match(listRes!, /test-session/);
    assert.match(listRes!, /ACTIVE/);

    const closeRes = await processIncomingMessage(TEST_JID, '/session close');
    assert.match(closeRes!, /Session Closed/);
  });

  await t.test('7. Configuration commands (/config, /model, /turns)', async () => {
    const modelRes = await processIncomingMessage(TEST_JID, '/model sonnet');
    assert.match(modelRes!, /claude-3-7-sonnet/);

    const turnsRes = await processIncomingMessage(TEST_JID, '/turns 15');
    assert.match(turnsRes!, /15/);

    const configRes = await processIncomingMessage(TEST_JID, '/config');
    assert.match(configRes!, /claude-3-7-sonnet/);
    assert.match(configRes!, /Max Turns:\s+15/);
  });

  await t.test('8. System status & help', async () => {
    const statusRes = await processIncomingMessage(TEST_JID, '/status');
    assert.match(statusRes!, /System Status/);

    const helpRes = await processIncomingMessage(TEST_JID, '/help cd');
    assert.match(helpRes!, /\/cd <path \| index>/);
  });

  closeDatabase();
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }
});
