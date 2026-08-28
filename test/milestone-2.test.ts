import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { setJobNotificationHandler, cancelJob } from '../src/jobs/job-manager.js';
import { getJobById, createJob, updateJobRunning } from '../src/database/repositories/job.repo.js';
import { getActiveSession } from '../src/database/repositories/session.repo.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';
import { isSessionLocked } from '../src/state/session-lock.js';
import { registerAgentDriver } from '../src/agents/agent-registry.js';
import { ClaudeCodeDriver } from '../src/agents/drivers/claude-code.driver.js';
import type { AgentRunOptions } from '../src/agents/agent-driver.interface.js';
import { config } from '../src/config.js';

const TEST_DB = path.resolve('./data/test_milestone_2.db');
const USER_A_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;
const USER_B_JID = `9876543210@s.whatsapp.net`;

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test('Milestone 2: Real /run Execution & Edge Cases', async (suite) => {
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }
  initDatabase(TEST_DB);

  // Setup User A project and active session
  await processIncomingMessage(USER_A_JID, '/session new m2-session');
  const db = getDatabase();
  const project = getActiveProject(USER_A_JID)!;
  const session = getActiveSession(project.id)!;

  // Also authorize User B for ownership testing
  db.prepare(`
    INSERT INTO users (id, phone_number, display_name, is_authorized, created_at, updated_at)
    VALUES (?, '9876543210', 'User B', 1, ?, ?)
  `).run(USER_B_JID, Date.now(), Date.now());

  await suite.test('1. End-to-End /run with valid JSON output and notification', async () => {
    class MockClaudeSuccessDriver extends ClaudeCodeDriver {
      buildCommandArgs(options: AgentRunOptions): string[] {
        const jsonPayload = JSON.stringify({
          result: 'Refactored authentication middleware successfully.',
          files_changed: [
            { path: 'src/auth.ts', additions: 12, deletions: 2 },
            { path: 'tests/auth.test.ts', additions: 30, deletions: 0 },
          ],
          usage: { input_tokens: 1500, output_tokens: 350 },
          cost: 0.08,
          turns: 3,
        });
        return [process.execPath, '-e', `console.log(${JSON.stringify(jsonPayload)})`];
      }
    }
    registerAgentDriver(new MockClaudeSuccessDriver());

    let notificationReceived = '';
    setJobNotificationHandler((userId, msg) => {
      notificationReceived = msg;
    });

    const runRes = await processIncomingMessage(USER_A_JID, '/run Fix the auth middleware');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    await waitFor(() => getJobById(jobId)?.status === 'COMPLETED');

    const completedJob = getJobById(jobId)!;
    assert.equal(completedJob.status, 'COMPLETED');
    assert.equal(completedJob.exit_code, 0);
    assert.equal(completedJob.cost_usd, 0.08);
    assert.equal(completedJob.tokens_in, 1500);
    assert.equal(completedJob.tokens_out, 350);
    assert.equal(completedJob.turns_used, 3);
    assert.match(completedJob.summary!, /Refactored authentication middleware/);

    assert.equal(isSessionLocked(session.id), false);
    assert.match(notificationReceived, /Job #/);
    assert.match(notificationReceived, /src\/auth\.ts/);

    const jobRes = await processIncomingMessage(USER_A_JID, `/job ${jobId}`);
    assert.match(jobRes!, /COMPLETED/);
    assert.match(jobRes!, /Cost: \$0.08/);

    const jobsListRes = await processIncomingMessage(USER_A_JID, '/jobs');
    assert.match(jobsListRes!, new RegExp(`#${jobId}`));
  });

  await suite.test('2. Two simultaneous /run commands in same session (Job Collision)', async () => {
    class MockSlowDriver extends ClaudeCodeDriver {
      buildCommandArgs(): string[] {
        return [process.execPath, '-e', `setTimeout(() => {}, 400)`];
      }
    }
    registerAgentDriver(new MockSlowDriver());

    const run1 = await processIncomingMessage(USER_A_JID, '/run Task One');
    assert.match(run1!, /Started/);
    const jobId1 = parseInt(run1!.match(/Task #(\d+) Started/)![1], 10);

    // Immediately try to start another task in same session
    const run2 = await processIncomingMessage(USER_A_JID, '/run Task Two');
    assert.match(run2!, /ERR_JOB_COLLISION/);

    // Wait for task 1 to finish cleanly before exiting test
    await waitFor(() => getJobById(jobId1)?.status === 'COMPLETED');
    assert.equal(isSessionLocked(session.id), false);
  });

  await suite.test('3. Cancellation during execution: RUNNING -> CANCEL_REQUESTED -> CANCELLED', async () => {
    class MockLongRunningDriver extends ClaudeCodeDriver {
      buildCommandArgs(): string[] {
        return [process.execPath, '-e', `setInterval(() => {}, 1000)`];
      }
    }
    registerAgentDriver(new MockLongRunningDriver());

    let cancelNotification = '';
    setJobNotificationHandler((userId, msg) => {
      cancelNotification = msg;
    });

    const runRes = await processIncomingMessage(USER_A_JID, '/run Long Running Task');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    await waitFor(() => getJobById(jobId)?.status === 'RUNNING');

    const cancelRes = await processIncomingMessage(USER_A_JID, `/cancel ${jobId}`);
    assert.match(cancelRes!, /Cancel Requested/);

    await waitFor(() => getJobById(jobId)?.status === 'CANCELLED');

    const job = getJobById(jobId)!;
    assert.equal(job.status, 'CANCELLED');
    assert.equal(job.failure_reason, 'USER_CANCEL');
    assert.equal(isSessionLocked(session.id), false);
    assert.match(cancelNotification, /Cancelled/);
  });

  await suite.test('4. Cancellation during QUEUED state', async () => {
    const job = createJob({
      sessionId: session.id,
      projectId: project.id,
      userId: USER_A_JID,
      prompt: 'Queued task',
      commandArgs: ['dummy'],
    });
    assert.equal(job.status, 'QUEUED');

    await cancelJob(job.id, USER_A_JID);

    const cancelled = getJobById(job.id)!;
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.failure_reason, 'USER_CANCEL');
  });

  await suite.test('5. Claude process crashes (non-zero exit code)', async () => {
    class MockCrashingDriver extends ClaudeCodeDriver {
      buildCommandArgs(): string[] {
        return [
          process.execPath,
          '-e',
          `console.error("FATAL: Out of memory or internal assertion failure"); process.exit(137);`,
        ];
      }
    }
    registerAgentDriver(new MockCrashingDriver());

    const runRes = await processIncomingMessage(USER_A_JID, '/run Crash me');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    await waitFor(() => getJobById(jobId)?.status === 'FAILED');

    const job = getJobById(jobId)!;
    assert.equal(job.status, 'FAILED');
    assert.equal(job.exit_code, 137);
    assert.equal(job.failure_reason, 'PROCESS_ERROR');
    assert.match(job.summary!, /FATAL: Out of memory/);
    assert.equal(isSessionLocked(session.id), false);
  });

  await suite.test('6. Malformed JSON output from Claude', async () => {
    class MockMalformedJsonDriver extends ClaudeCodeDriver {
      buildCommandArgs(): string[] {
        return [
          process.execPath,
          '-e',
          `console.log("{ broken json: [unclosed"); process.exit(0);`,
        ];
      }
    }
    registerAgentDriver(new MockMalformedJsonDriver());

    const runRes = await processIncomingMessage(USER_A_JID, '/run Malformed JSON task');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    await waitFor(() => getJobById(jobId)?.status === 'COMPLETED');

    const job = getJobById(jobId)!;
    assert.equal(job.status, 'COMPLETED');
    assert.match(job.summary!, /broken json/);
    assert.equal(job.cost_usd, null); // Strictly nullable
    assert.equal(isSessionLocked(session.id), false);
  });

  await suite.test('7. Binary missing / invalid executable', async () => {
    class MockMissingBinaryDriver extends ClaudeCodeDriver {
      buildCommandArgs(): string[] {
        return ['/usr/bin/nonexistent-claude-binary-xyz', '-p', 'hello'];
      }
    }
    registerAgentDriver(new MockMissingBinaryDriver());

    const runRes = await processIncomingMessage(USER_A_JID, '/run Nonexistent binary');
    assert.match(runRes!, /ERR_INVALID_ARG/);

    // Verify session lock was released and not leaked
    assert.equal(isSessionLocked(session.id), false);
  });

  await suite.test('8. >5 MB Output Truncation Protection', async () => {
    class MockLargeOutputDriver extends ClaudeCodeDriver {
      buildCommandArgs(): string[] {
        return [
          process.execPath,
          '-e',
          `
          const chunk = "A".repeat(1024 * 1024); // 1MB
          for (let i = 0; i < 6; i++) {
            process.stdout.write(chunk);
          }
          `,
        ];
      }
    }
    registerAgentDriver(new MockLargeOutputDriver());

    const runRes = await processIncomingMessage(USER_A_JID, '/run Generate large output');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    await waitFor(() => getJobById(jobId)?.status === 'COMPLETED', 8000);

    const job = getJobById(jobId)!;
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.stdout_truncated, 1);
    assert.ok(job.stdout_bytes >= 5 * 1024 * 1024);

    const jobDetails = await processIncomingMessage(USER_A_JID, `/job ${jobId}`);
    assert.match(jobDetails!, /Output exceeded 5MB memory limit and was truncated/);
    assert.equal(isSessionLocked(session.id), false);
  });

  await suite.test('9. Unauthorized cross-user job querying', async () => {
    const userAJobs = db.prepare('SELECT id FROM jobs WHERE user_id = ? LIMIT 1').get(USER_A_JID) as any;
    assert.ok(userAJobs);

    const unauthorizedRes = await processIncomingMessage(USER_B_JID, `/job ${userAJobs.id}`);
    assert.match(unauthorizedRes!, /ERR_NOT_FOUND/);

    const unauthorizedCancel = await processIncomingMessage(USER_B_JID, `/cancel ${userAJobs.id}`);
    assert.match(unauthorizedCancel!, /ERR_NOT_FOUND/);
  });

  await suite.test('10. Crash/restart recovery of in-flight jobs', async () => {
    const orphanRunning = createJob({
      sessionId: session.id,
      projectId: project.id,
      userId: USER_A_JID,
      prompt: 'Task died during server restart',
      commandArgs: ['claude'],
    });
    updateJobRunning(orphanRunning.id, 99999);

    const orphanQueued = createJob({
      sessionId: session.id,
      projectId: project.id,
      userId: USER_A_JID,
      prompt: 'Queued task died during server restart',
      commandArgs: ['claude'],
    });

    assert.equal(getJobById(orphanRunning.id)?.status, 'RUNNING');
    assert.equal(getJobById(orphanQueued.id)?.status, 'QUEUED');

    // Simulate server crash & restart by re-initializing DB
    closeDatabase();
    initDatabase(TEST_DB);

    const recoveredRunning = getJobById(orphanRunning.id)!;
    assert.equal(recoveredRunning.status, 'FAILED');
    assert.equal(recoveredRunning.failure_reason, 'SERVER_RESTART');
    assert.ok(recoveredRunning.finished_at !== null);

    const recoveredQueued = getJobById(orphanQueued.id)!;
    assert.equal(recoveredQueued.status, 'FAILED');
    assert.equal(recoveredQueued.failure_reason, 'SERVER_RESTART');
  });

  closeDatabase();
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }
});
