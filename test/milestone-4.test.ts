import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { initDatabase, closeDatabase, getDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { startHealthServer, stopHealthServer, registerWhatsAppStateProvider } from '../src/health.js';
import { checkAndRecordRateLimit, resetRateLimits } from '../src/security/rate-limiter.js';
import { resolveSafePath } from '../src/security/sandbox.js';
import { executeMessagePipeline } from '../src/whatsapp/message-pipeline.js';
import { launchJob, cancelJob, shutdownAllJobs } from '../src/jobs/job-manager.js';
import { getJobById } from '../src/database/repositories/job.repo.js';
import { getActiveSession } from '../src/database/repositories/session.repo.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';
import { isSessionLocked } from '../src/state/session-lock.js';
import { registerAgentDriver } from '../src/agents/agent-registry.js';
import { ClaudeCodeDriver } from '../src/agents/drivers/claude-code.driver.js';
import { sanitizePromptForLog } from '../src/logger.js';
import { LIMITS } from '../src/security/limits.js';
import { config } from '../src/config.js';
import type { proto } from '@whiskeysockets/baileys';

const TEST_DB = path.resolve('./data/test_milestone_4.db');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;
const USER_B_JID = `9876543210@s.whatsapp.net`;
const HEALTH_TEST_PORT = 8999;

function httpGet(url: string): Promise<{ statusCode: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode || 500, data: JSON.parse(body) });
        } catch {
          resolve({ statusCode: res.statusCode || 500, data: body });
        }
      });
    }).on('error', reject);
  });
}

test('Milestone 4: Production Hardening, Observability & Security Audit', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);
  resetRateLimits();

  // Setup: create active session for admin
  await processIncomingMessage(ADMIN_JID, '/session new m4-hardening');
  const project = getActiveProject(ADMIN_JID)!;
  const session = getActiveSession(project.id)!;

  // Authorize User B
  const db = getDatabase();
  db.prepare(`
    INSERT INTO users (id, phone_number, display_name, is_authorized, created_at, updated_at)
    VALUES (?, '9876543210', 'User B', 1, ?, ?)
  `).run(USER_B_JID, Date.now(), Date.now());

  await suite.test('1. Structured logging: sanitizePromptForLog truncates prompts', () => {
    const shortPrompt = 'Fix authentication bug';
    assert.equal(sanitizePromptForLog(shortPrompt), 'Fix authentication bug');

    const longPrompt = 'A'.repeat(200);
    const sanitized = sanitizePromptForLog(longPrompt, 50);
    assert.ok(sanitized.includes('... [truncated 150 chars]'));
    assert.ok(sanitized.length < 90);
  });

  await suite.test('2. Rate limiting: /run rate limit enforces max 5 runs/min', () => {
    resetRateLimits(ADMIN_JID);

    // 5 allowed runs
    for (let i = 0; i < 5; i++) {
      assert.doesNotThrow(() => checkAndRecordRateLimit(ADMIN_JID, 'run'));
    }

    // 6th run must throw RateLimitedError
    assert.throws(
      () => checkAndRecordRateLimit(ADMIN_JID, 'run'),
      (err: any) => err.category === 'ERR_RATE_LIMITED' && err.reason.includes('Too many requests')
    );

    resetRateLimits(ADMIN_JID);
  });

  await suite.test('3. Rate limiting: filesystem commands enforce max 30 ops/min', () => {
    resetRateLimits(ADMIN_JID);

    for (let i = 0; i < 30; i++) {
      assert.doesNotThrow(() => checkAndRecordRateLimit(ADMIN_JID, 'filesystem'));
    }

    assert.throws(
      () => checkAndRecordRateLimit(ADMIN_JID, 'filesystem'),
      (err: any) => err.category === 'ERR_RATE_LIMITED'
    );

    resetRateLimits(ADMIN_JID);
  });

  await suite.test('4. Health & Readiness HTTP Endpoints', async () => {
    await startHealthServer(HEALTH_TEST_PORT);
    registerWhatsAppStateProvider(() => 'OPEN');

    // /health
    const health = await httpGet(`http://localhost:${HEALTH_TEST_PORT}/health`);
    assert.equal(health.statusCode, 200);
    assert.equal(health.data.status, 'ok');
    assert.ok(typeof health.data.uptime === 'number');

    // /ready (healthy)
    const ready = await httpGet(`http://localhost:${HEALTH_TEST_PORT}/ready`);
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.data.status, 'ready');

    // /ready (unhealthy when WhatsApp is logged out)
    registerWhatsAppStateProvider(() => 'LOGGED_OUT');
    const notReady = await httpGet(`http://localhost:${HEALTH_TEST_PORT}/ready`);
    assert.equal(notReady.statusCode, 503);
    assert.equal(notReady.data.status, 'not_ready');
    assert.ok(notReady.data.issues.includes('whatsapp_logged_out'));

    await stopHealthServer();
  });

  await suite.test('5. Graceful shutdown: shutdownAllJobs terminates active process groups cleanly', async () => {
    class MockHangingDriver extends ClaudeCodeDriver {
      buildCommandArgs(): string[] {
        return [process.execPath, '-e', `setInterval(() => {}, 1000)`];
      }
    }
    registerAgentDriver(new MockHangingDriver());

    const job = await launchJob(ADMIN_JID, project, session, 'Hanging task to shut down');
    assert.ok(job.id);
    assert.equal(isSessionLocked(session.id), true);

    // Call shutdownAllJobs
    await shutdownAllJobs(1000);

    const cancelledJob = getJobById(job.id)!;
    assert.equal(cancelledJob.status, 'CANCELLED');
    assert.equal(cancelledJob.failure_reason, 'USER_CANCEL');
    assert.equal(isSessionLocked(session.id), false);
  });

  await suite.test('6. Security: Symlink escape protection', async () => {
    const sandboxDir = config.ALLOWED_ROOTS[0];
    const testSymlinkPath = path.join(sandboxDir, 'test_symlink_escape');

    try {
      // Create symlink pointing outside sandbox (e.g. to /tmp or /etc)
      if (fs.existsSync(testSymlinkPath)) fs.unlinkSync(testSymlinkPath);
      fs.symlinkSync('/etc', testSymlinkPath, 'dir');

      // Attempting to resolve safe path through the symlink must be blocked
      await assert.rejects(
        async () => {
          await resolveSafePath(testSymlinkPath, sandboxDir, config.ALLOWED_ROOTS);
        },
        (err: any) => err.category === 'ERR_SANDBOX_VIOLATION'
      );
    } finally {
      if (fs.existsSync(testSymlinkPath)) fs.unlinkSync(testSymlinkPath);
    }
  });

  await suite.test('7. Security: Null-byte injection protection', async () => {
    const sandboxDir = config.ALLOWED_ROOTS[0];
    const maliciousPath = `package.json\0/../../etc/passwd`;

    await assert.rejects(
      async () => {
        await resolveSafePath(maliciousPath, sandboxDir, config.ALLOWED_ROOTS);
      },
      (err: any) => err.category === 'ERR_SANDBOX_VIOLATION'
    );
  });

  await suite.test('8. Security: Cross-user session & job isolation', async () => {
    // User A has jobs
    const userAJobs = db.prepare('SELECT id FROM jobs WHERE user_id = ? LIMIT 1').get(ADMIN_JID) as any;
    if (userAJobs) {
      // User B attempts to access User A's job
      const res = await processIncomingMessage(USER_B_JID, `/job ${userAJobs.id}`);
      assert.match(res!, /ERR_NOT_FOUND/);

      // User B attempts to cancel User A's job
      const cancelRes = await processIncomingMessage(USER_B_JID, `/cancel ${userAJobs.id}`);
      assert.match(cancelRes!, /ERR_NOT_FOUND/);
    }
  });

  await suite.test('9. Resource limits: Oversized prompt rejected', async () => {
    resetRateLimits(ADMIN_JID);
    const oversizedPrompt = 'A'.repeat(LIMITS.MAX_PROMPT_CHARS + 50);

    const res = await processIncomingMessage(ADMIN_JID, `/run ${oversizedPrompt}`);
    assert.match(res!, /ERR_INVALID_ARG/);
    assert.match(res!, /exceeds maximum limit/);
  });

  await suite.test('10. Resource limits: Oversized inbound message rejected', async () => {
    resetRateLimits(ADMIN_JID);
    const oversizedText = '/run ' + 'B'.repeat(LIMITS.MAX_MESSAGE_CHARS + 100);

    const rawMsg: proto.IWebMessageInfo = {
      key: { id: 'OVERSIZED_1', remoteJid: ADMIN_JID, fromMe: false },
      message: { conversation: oversizedText },
    };

    const res = await executeMessagePipeline(rawMsg);
    assert.equal(res.shouldReply, true);
    assert.match(res.replyText!, /ERR_INVALID_ARG/);
    assert.match(res.replyText!, /Message exceeds maximum allowed size/);
  });

  await suite.test('11. Security: Grep regex pattern length limit prevents ReDoS', async () => {
    resetRateLimits(ADMIN_JID);
    const longPattern = 'a'.repeat(250);

    const res = await processIncomingMessage(ADMIN_JID, `/grep "${longPattern}"`);
    assert.match(res!, /ERR_INVALID_ARG/);
    assert.match(res!, /Pattern exceeds maximum allowed length/);
  });

  closeDatabase();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});
