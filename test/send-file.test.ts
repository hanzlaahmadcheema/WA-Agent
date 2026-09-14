import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import type { FileSendResult } from '../src/commands/send-file.cmd.js';

const TEST_DB = path.resolve('./data/test_send_file.db');
const TEST_JID = '923124706501@s.whatsapp.net';
const TEMP_DIR = path.resolve('./data/test_send_artifacts');

test('Send Artifacts & Media to WhatsApp Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);

  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  // Create test files
  const testTxt = path.join(TEMP_DIR, 'summary.txt');
  fs.writeFileSync(testTxt, 'Analysis summary report content');

  const testPng = path.join(TEMP_DIR, 'plot.png');
  fs.writeFileSync(testPng, Buffer.from('fake-png-data'));

  await suite.test('1. Setup CLI session and navigate to temp dir', async () => {
    await processIncomingMessage(TEST_JID, '/start');
    const cdRes = await processIncomingMessage(TEST_JID, `/cd ${TEMP_DIR}`);
    assert.match(String(cdRes), /test_send_artifacts/);
  });

  await suite.test('2. Missing target argument errors gracefully', async () => {
    const res = await processIncomingMessage(TEST_JID, '/send');
    assert.match(String(res), /File name or index is required/);
  });

  await suite.test('3. Non-existent file errors gracefully', async () => {
    const res = await processIncomingMessage(TEST_JID, '/send missing.txt');
    assert.match(String(res), /File "missing\.txt" not found/);
  });

  await suite.test('4. Send text/document file returns media payload', async () => {
    const res = (await processIncomingMessage(TEST_JID, '/send summary.txt')) as FileSendResult;
    assert.equal(typeof res, 'object');
    assert.match(res.text, /Sending file/);
    assert.match(res.text, /summary\.txt/);
    assert.ok(res.media);
    assert.ok(res.media.document);
    assert.equal(res.media.fileName, 'summary.txt');
    assert.equal(res.media.mimetype, 'text/plain');
  });

  await suite.test('5. Send image returns image media payload', async () => {
    const res = (await processIncomingMessage(TEST_JID, '/send plot.png')) as FileSendResult;
    assert.equal(typeof res, 'object');
    assert.match(res.text, /Sending image/);
    assert.match(res.text, /plot\.png/);
    assert.ok(res.media);
    assert.ok(res.media.image);
    assert.equal(res.media.caption, '📄 plot.png');
  });

  await suite.test('6. Sandbox escape is blocked', async () => {
    const res = await processIncomingMessage(TEST_JID, '/send /etc/shadow');
    assert.match(String(res), /Path outside sandbox/);
  });

  // Cleanup
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
});
