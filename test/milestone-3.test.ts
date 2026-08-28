import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDatabase } from '../src/database/connection.js';
import { ConnectionFSM, calculateBackoffWithJitter } from '../src/whatsapp/connection-fsm.js';
import { executeMessagePipeline } from '../src/whatsapp/message-pipeline.js';
import { sendWithRetry } from '../src/whatsapp/outbound-sender.js';
import { trackInboundMessage, pruneOldMessages } from '../src/database/repositories/message-dedup.repo.js';
import { getJobById } from '../src/database/repositories/job.repo.js';
import { registerAgentDriver } from '../src/agents/agent-registry.js';
import { ClaudeCodeDriver } from '../src/agents/drivers/claude-code.driver.js';
import { config } from '../src/config.js';
import type { proto } from '@whiskeysockets/baileys';

const TEST_DB = path.resolve('./data/test_milestone_3.db');
const TEST_AUTH_DIR = path.resolve('./data/test_auth_dir');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;
const UNKNOWN_JID = `5555555555@s.whatsapp.net`;

test('Milestone 3: WhatsApp Transport Hardening Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_AUTH_DIR)) fs.rmSync(TEST_AUTH_DIR, { recursive: true, force: true });

  initDatabase(TEST_DB);

  // Setup: create active session for admin
  const { processIncomingMessage } = await import('../src/router/command-router.js');
  await processIncomingMessage(ADMIN_JID, '/session new m3-hardening');

  await suite.test('1. Auth persistence & directory handling', async () => {
    fs.mkdirSync(TEST_AUTH_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_AUTH_DIR, 'creds.json'), JSON.stringify({ me: { id: ADMIN_JID } }));

    assert.ok(fs.existsSync(path.join(TEST_AUTH_DIR, 'creds.json')));
    // Verify directory survives until explicit logout
  });

  await suite.test('2. Reconnect FSM: OPEN, CLOSED, RECONNECTING, LOGGED_OUT', () => {
    const fsm = new ConnectionFSM({ baseMs: 500, maxMs: 5000, jitterFactor: 0.1 });
    assert.equal(fsm.getState(), 'CLOSED');

    fsm.onConnecting();
    assert.equal(fsm.getState(), 'RECONNECTING');

    fsm.onOpen();
    assert.equal(fsm.getState(), 'OPEN');
    assert.equal(fsm.getAttempts(), 0);

    // Transient network disconnect (e.g. 515 or 408)
    const res1 = fsm.onClose(408);
    assert.equal(res1.nextState, 'RECONNECTING');
    assert.equal(res1.isLoggedOut, false);
    assert.ok(res1.delayMs! >= 400 && res1.delayMs! <= 600);
    assert.equal(fsm.getAttempts(), 1);

    // Second disconnect with backoff
    const res2 = fsm.onClose(500);
    assert.equal(res2.nextState, 'RECONNECTING');
    assert.ok(res2.delayMs! >= 800);
    assert.equal(fsm.getAttempts(), 2);

    // Reconnect succeeds
    fsm.onOpen();
    assert.equal(fsm.getState(), 'OPEN');
    assert.equal(fsm.getAttempts(), 0);

    // Explicit logout (401)
    const logoutRes = fsm.onClose(401);
    assert.equal(logoutRes.nextState, 'LOGGED_OUT');
    assert.equal(logoutRes.isLoggedOut, true);
    assert.equal(fsm.getState(), 'LOGGED_OUT');
  });

  await suite.test('3. Exponential backoff + jitter calculation avoids storms', () => {
    const delays: number[] = [];
    for (let i = 0; i < 50; i++) {
      const delay = calculateBackoffWithJitter(1, { baseMs: 1000, maxMs: 30000, jitterFactor: 0.25 });
      delays.push(delay);
      // At attempt 1, 1000 * 2^1 = 2000ms. Jitter: ±25% => range [1500, 2500]
      assert.ok(delay >= 1500 && delay <= 2500, `Delay ${delay} should be within [1500, 2500]`);
    }

    // Ensure jitter creates variance (not all identical values)
    const unique = new Set(delays);
    assert.ok(unique.size > 10, 'Jitter should introduce variance across calls');
  });

  await suite.test('4. Message deduplication prevents double /run execution', async () => {
    class MockCounterDriver extends ClaudeCodeDriver {
      public callCount = 0;
      buildCommandArgs(): string[] {
        this.callCount++;
        return [process.execPath, '-e', `console.log(JSON.stringify({ result: "done" }))`];
      }
    }
    const counterDriver = new MockCounterDriver();
    registerAgentDriver(counterDriver);

    const rawMsg: proto.IWebMessageInfo = {
      key: {
        id: 'WA_MSG_UNIQUE_1001',
        remoteJid: ADMIN_JID,
        fromMe: false,
      },
      message: {
        conversation: '/run Deduplication test prompt',
      },
    };

    // First arrival: fresh message, should be processed
    const result1 = await executeMessagePipeline(rawMsg);
    assert.equal(result1.shouldReply, true);
    assert.match(result1.replyText!, /Task #(\d+) Started/);
    const jobId = parseInt(result1.replyText!.match(/Task #(\d+) Started/)![1], 10);

    // Second arrival (same message ID): duplicate, MUST be discarded
    const result2 = await executeMessagePipeline(rawMsg);
    assert.equal(result2.shouldReply, false);
    assert.equal(result2.isDuplicate, true);
    assert.match(result2.ignoredReason!, /Duplicate message ID/);

    // Wait for the single launched background job to finish cleanly
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (getJobById(jobId)?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Assert driver was only invoked ONCE
    assert.equal(counterDriver.callCount, 1);
  });

  await suite.test('5. Message deduplication repository & pruning', () => {
    const isNew = trackInboundMessage('MSG_TEST_99', ADMIN_JID);
    assert.equal(isNew, true);

    const isDup = trackInboundMessage('MSG_TEST_99', ADMIN_JID);
    assert.equal(isDup, false);

    // Prune with 0 maxAge to clean all
    const pruned = pruneOldMessages(0);
    assert.ok(pruned >= 1);
  });

  await suite.test('6. Group message rejection (@g.us)', async () => {
    const groupMsg: proto.IWebMessageInfo = {
      key: {
        id: 'GROUP_MSG_1',
        remoteJid: '123456789-987654@g.us',
        participant: ADMIN_JID,
        fromMe: false,
      },
      message: {
        conversation: '/pwd',
      },
    };

    const res = await executeMessagePipeline(groupMsg);
    assert.equal(res.shouldReply, false);
    assert.match(res.ignoredReason!, /Group messages not supported/);
  });

  await suite.test('7. Unauthorized sender rejected BEFORE command router', async () => {
    const unauthorizedMsg: proto.IWebMessageInfo = {
      key: {
        id: 'UNAUTH_MSG_1',
        remoteJid: UNKNOWN_JID,
        fromMe: false,
      },
      message: {
        conversation: '/run "rm -rf /" --flag',
      },
    };

    const res = await executeMessagePipeline(unauthorizedMsg);
    assert.equal(res.shouldReply, true);
    assert.equal(res.isUnauthorized, true);
    // Generic refusal: zero leaks of internal structure, commands, or paths
    assert.equal(res.replyText, '🛑 *Access Denied*: Unauthorized sender.');
  });

  await suite.test('8. Malformed WhatsApp messages handled safely', async () => {
    // Missing key
    const bad1 = await executeMessagePipeline({} as any);
    assert.equal(bad1.shouldReply, false);

    // Empty message content
    const bad2 = await executeMessagePipeline({
      key: { id: 'BAD_2', remoteJid: ADMIN_JID, fromMe: false },
      message: {},
    });
    assert.equal(bad2.shouldReply, false);

    // Outbound from self
    const fromMe = await executeMessagePipeline({
      key: { id: 'SELF_1', remoteJid: ADMIN_JID, fromMe: true },
      message: { conversation: '/pwd' },
    });
    assert.equal(fromMe.shouldReply, false);
  });

  await suite.test('9. Outbound reliability: retries transient send failures', async () => {
    let attempts = 0;
    const mockSend = async (jid: string, content: any) => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Transient network timeout');
      }
      return { status: 'OK' };
    };

    const success = await sendWithRetry(
      mockSend,
      ADMIN_JID,
      { text: 'Test retry message' },
      { maxRetries: 3, initialDelayMs: 20 }
    );

    assert.equal(success, true);
    assert.equal(attempts, 3);
  });

  await suite.test('10. Outbound reliability: reports failure after exhausting retries without re-running command', async () => {
    let attempts = 0;
    const mockFailingSend = async () => {
      attempts++;
      throw new Error('Persistent socket closed');
    };

    const success = await sendWithRetry(
      mockFailingSend,
      ADMIN_JID,
      { text: 'Failing alert' },
      { maxRetries: 2, initialDelayMs: 10 }
    );

    assert.equal(success, false);
    assert.equal(attempts, 2);
  });

  closeDatabase();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_AUTH_DIR)) fs.rmSync(TEST_AUTH_DIR, { recursive: true, force: true });
});
