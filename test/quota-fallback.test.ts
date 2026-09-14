import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import {
  isQuotaOrAuthError,
  setQuotaFallback,
  getQuotaFallback,
  clearQuotaFallback,
  formatQuotaFallbackMessage,
  getAlternativeAgent,
} from '../src/jobs/quota-fallback.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';
import { registerAgentDriver } from '../src/agents/agent-registry.js';
import { OpenCodeDriver } from '../src/agents/drivers/opencode.driver.js';
import { AntigravityDriver } from '../src/agents/drivers/antigravity.driver.js';
import type { AgentRunOptions } from '../src/agents/agent-driver.interface.js';

const TEST_DB = path.resolve('./data/test_quota_fallback.db');
const TEST_JID = '923124706501@s.whatsapp.net';

class FastMockDriver extends OpenCodeDriver {
  buildCommandArgs(options: AgentRunOptions): string[] {
    return [process.execPath, '-e', 'console.log("Mock completed")'];
  }
}

class FastMockAntigravityDriver extends AntigravityDriver {
  buildCommandArgs(options: AgentRunOptions): string[] {
    return [process.execPath, '-e', 'console.log("Mock completed")'];
  }
}

test('Smart Quota Fallback & Agent Auto-Switcher Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);

  registerAgentDriver(new FastMockDriver());
  registerAgentDriver(new FastMockAntigravityDriver());

  await suite.test('1. isQuotaOrAuthError correctly identifies quota and auth errors', () => {
    assert.equal(isQuotaOrAuthError('RESOURCE_EXHAUSTED: Quota reached'), true);
    assert.equal(isQuotaOrAuthError('Rate limit exceeded. Try again in 60s'), true);
    assert.equal(isQuotaOrAuthError('HTTP 429: Too Many Requests'), true);
    assert.equal(isQuotaOrAuthError('Error: not logged in. Please run /login'), true);
    assert.equal(isQuotaOrAuthError('Syntax error on line 42'), false);
    assert.equal(isQuotaOrAuthError(null), false);
  });

  await suite.test('2. Quota fallback context lifecycle & format message', () => {
    clearQuotaFallback(TEST_JID);
    assert.equal(getQuotaFallback(TEST_JID), null);

    setQuotaFallback({
      userId: TEST_JID,
      projectId: 'proj_123',
      sessionId: 'sess_abc',
      failedAgent: 'antigravity',
      prompt: 'Fix the search indexing bug',
      timestamp: Date.now(),
    });

    const ctx = getQuotaFallback(TEST_JID);
    assert.ok(ctx);
    assert.equal(ctx.failedAgent, 'antigravity');

    const msg = formatQuotaFallbackMessage(ctx);
    assert.match(msg, /Quota or Auth Limit Reached/);
    assert.match(msg, /Switch Agent & Auto-Retry/);
    assert.match(msg, /OpenCode/);

    const alt1 = getAlternativeAgent(ctx, 1);
    assert.ok(alt1);
    assert.notEqual(alt1, 'antigravity');
  });

  await suite.test('3. Replying with 1-tap numeric selection switches agent and retries job', async () => {
    // Start session and create project
    await processIncomingMessage(TEST_JID, '/start');
    await processIncomingMessage(TEST_JID, '/project select WA-Agent');
    await processIncomingMessage(TEST_JID, '/agent select antigravity');
    await processIncomingMessage(TEST_JID, '/session new quota-test-session');

    const proj = getActiveProject(TEST_JID);
    assert.ok(proj);
    assert.equal(proj.selected_agent, 'antigravity');

    // Manually trigger a quota fallback state
    setQuotaFallback({
      userId: TEST_JID,
      projectId: proj.id,
      sessionId: 'sess_dummy',
      failedAgent: 'antigravity',
      prompt: 'Refactor logger system',
      timestamp: Date.now(),
    });

    // Send "1" to select the first alternative agent
    const retryRes = await processIncomingMessage(TEST_JID, '1');
    assert.match(String(retryRes), /Switched Agent to/);
    assert.match(String(retryRes), /Retrying Job/);

    // Verify project agent was updated in database
    const updatedProj = getActiveProject(TEST_JID);
    assert.ok(updatedProj);
    assert.notEqual(updatedProj.selected_agent, 'antigravity');
  });
});
