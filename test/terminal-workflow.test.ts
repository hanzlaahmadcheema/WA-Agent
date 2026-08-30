import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { resetRateLimits } from '../src/security/rate-limiter.js';
import { getUserNavCwd, setUserNavCwd, resetUserNav } from '../src/state/user-nav.js';
import { stopCliSession } from '../src/state/cli-session.js';
import { config } from '../src/config.js';

const TEST_DB = path.resolve('./data/test_terminal_workflow.db');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;
const STRANGER_JID = '9876543210@s.whatsapp.net';

test('Milestone 6: WhatsApp Terminal Navigation & Session Workflow Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);
  resetRateLimits();
  resetUserNav(ADMIN_JID);
  stopCliSession(ADMIN_JID);

  suite.after(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  const allowedRoot = config.ALLOWED_ROOTS[0];

  await suite.test('6A. Terminal Navigation: /menu, /pwd, /ls, /cd, /back, and root boundary', async () => {
    // 0. Before /start, commands like /ls are blocked
    const preBlocked = await processIncomingMessage(ADMIN_JID, '/ls');
    assert.match(preBlocked!, /⏸️ \*WA-Agent CLI is stopped\.\*/);

    // 1. Start CLI session
    const startInit = await processIncomingMessage(ADMIN_JID, '/start');
    assert.match(startInit!, /🚀 \*WA-Agent CLI Started\*/);

    // 2. Menu displays full context header
    const menuRes = await processIncomingMessage(ADMIN_JID, '/menu');
    assert.ok(menuRes);
    assert.match(menuRes, /🤖 \*WA-Agent\*/);
    assert.match(menuRes, /📍 \*Directory\*/);
    assert.match(menuRes, /📁 \*Project\*\s+Not selected/);
    assert.match(menuRes, /🧠 \*Agent\*\s+Not selected/);
    assert.match(menuRes, /💬 \*Session\*\s+Not created/);
    assert.match(menuRes, /\*STATUS\*: 🟡 Setup required/);

    // 2. /pwd shows allowed root by default
    const pwdRes = await processIncomingMessage(ADMIN_JID, '/pwd');
    assert.match(pwdRes!, /📍 Current directory:/);
    assert.match(pwdRes!, new RegExp(allowedRoot));

    // 3. /ls lists items with icons
    const lsRes = await processIncomingMessage(ADMIN_JID, '/ls');
    assert.match(lsRes!, /📁/);

    // 4. /cd WA-Agent enters project folder
    const cdRes = await processIncomingMessage(ADMIN_JID, '/cd WA-Agent');
    assert.match(cdRes!, /📍 Current directory:/);
    assert.match(cdRes!, /WA-Agent/);

    // Verify user navigation cwd is updated
    const currentNavCwd = getUserNavCwd(ADMIN_JID);
    assert.match(currentNavCwd, /WA-Agent/);

    // 5. /back returns to parent
    const backRes = await processIncomingMessage(ADMIN_JID, '/back');
    assert.match(backRes!, /📍 Current directory:/);
    assert.equal(getUserNavCwd(ADMIN_JID), allowedRoot);

    // 6. Traversal boundary: cd /etc or ../../etc rejected
    const etcRes = await processIncomingMessage(ADMIN_JID, '/cd /etc');
    assert.match(etcRes!, /ERR_SANDBOX_VIOLATION/);

    const escapeRes = await processIncomingMessage(ADMIN_JID, '/cd ../../../etc');
    assert.match(escapeRes!, /ERR_SANDBOX_VIOLATION/);
  });

  await suite.test('6B. Project Context: /project select declares active project', async () => {
    // 1. Check initial project status
    const initialRes = await processIncomingMessage(ADMIN_JID, '/project');
    assert.match(initialRes!, /📁 \*Project: Not selected\*/);

    // 2. Navigate to WA-Agent
    await processIncomingMessage(ADMIN_JID, '/cd WA-Agent');

    // 3. Declare active project
    const projSelectRes = await processIncomingMessage(ADMIN_JID, '/project select');
    assert.match(projSelectRes!, /📦 \*Project selected\*/);
    assert.match(projSelectRes!, /WA-Agent/);
    assert.match(projSelectRes!, /Agent:\s+Not selected/);
    assert.match(projSelectRes!, /Session:\s+Not created/);

    // 4. Inspect /project
    const projRes = await processIncomingMessage(ADMIN_JID, '/project');
    assert.match(projRes!, /📦 \*Active Project\*/);
    assert.match(projRes!, /WA-Agent/);

    // 5. /project list
    const projListRes = await processIncomingMessage(ADMIN_JID, '/project list');
    assert.match(projListRes!, /🟢 \*WA-Agent\* \(Active\)/);
  });

  await suite.test('6C. Agent Context: /agent select scopes agent to project', async () => {
    // 1. /agent lists available agents
    const agentMenuRes = await processIncomingMessage(ADMIN_JID, '/agent');
    assert.match(agentMenuRes!, /🧠 \*Select Agent\*/);
    assert.match(agentMenuRes!, /1\. .*Claude Code/);
    assert.match(agentMenuRes!, /3\. .*Codex/);

    // 2. /agent select 3 (Codex CLI)
    const selectRes = await processIncomingMessage(ADMIN_JID, '/agent select 3');
    assert.match(selectRes!, /🧠 \*Agent selected\*/);
    assert.match(selectRes!, /Codex CLI/);
    assert.match(selectRes!, /📦 \*Project:\*\s+WA-Agent/);
    assert.match(selectRes!, /💬 \*Session:\*\s+Not created/);
  });

  await suite.test('6D. Execution Gate: /run rejected without session', async () => {
    // Attempting to /run without a created session MUST fail with clear guidance
    const runRes = await processIncomingMessage(ADMIN_JID, '/run "test gate"');
    assert.match(runRes!, /⚠️ \*No session exists\.\*/);
    assert.match(runRes!, /\*Current project:\*\s+WA-Agent/);
    assert.match(runRes!, /\*Agent:\*\s+Codex CLI/);
    assert.match(runRes!, /Create a session first:/);
    assert.match(runRes!, /\/session create/);
  });

  await suite.test('6E. Session Context: /session create, list, info, and execution gate pass', async () => {
    // 1. Create session
    const createRes = await processIncomingMessage(ADMIN_JID, '/session create workflow-sess');
    assert.match(createRes!, /✨ \*New Session Created\*/);
    assert.match(createRes!, /Agent:\s+Codex CLI/);
    assert.match(createRes!, /Project:\s+WA-Agent/);
    assert.match(createRes!, /Ready\./);

    // 2. /menu now reflects Ready state
    const menuRes = await processIncomingMessage(ADMIN_JID, '/menu');
    assert.match(menuRes!, /📁 \*Project\*\s+WA-Agent/);
    assert.match(menuRes!, /🧠 \*Agent\*\s+Codex CLI/);
    assert.match(menuRes!, /💬 \*Session\*\s+#/);
    assert.match(menuRes!, /\*STATUS\*: 🟢 Ready/);

    // 3. /session info
    const infoRes = await processIncomingMessage(ADMIN_JID, '/session info');
    assert.match(infoRes!, /💬 \*Sessions\*/);
    assert.match(infoRes!, /Agent: Codex CLI/);
    assert.match(infoRes!, /Project: WA-Agent/);

    // 4. /session list
    const listRes = await processIncomingMessage(ADMIN_JID, '/session list');
    assert.match(listRes!, /▶ #/);
    assert.match(listRes!, /Codex CLI/);
    assert.match(listRes!, /WA-Agent/);
  });

  await suite.test('6F. Security: unauthorized sender, project isolation, and navigation persistence', async () => {
    // 1. Stranger sender blocked
    const strangerRes = await processIncomingMessage(STRANGER_JID, '/menu', 'Attacker');
    assert.match(strangerRes!, /ERR_UNAUTHORIZED/);

    // 2. Navigation persistence: verify saved nav state
    const navCwdBefore = getUserNavCwd(ADMIN_JID);
    assert.ok(fs.existsSync(navCwdBefore));

    // Change nav dir and test persistence
    setUserNavCwd(ADMIN_JID, allowedRoot);
    assert.equal(getUserNavCwd(ADMIN_JID), allowedRoot);
  });

  await suite.test('6G. CLI Lifecycle: /start and /stop session gating', async () => {
    // 1. Explicitly stop CLI
    const stopRes = await processIncomingMessage(ADMIN_JID, '/stop');
    assert.match(stopRes!, /⏹️ \*WA-Agent CLI Stopped\*/);

    // 2. /ls should NOT work when stopped
    const lsStoppedRes = await processIncomingMessage(ADMIN_JID, '/ls');
    assert.match(lsStoppedRes!, /⏸️ \*WA-Agent CLI is stopped\.\*/);
    assert.match(lsStoppedRes!, /Type `\/start` to begin your session\./);

    // 3. /cd should NOT work when stopped
    const cdStoppedRes = await processIncomingMessage(ADMIN_JID, '/cd WA-Agent');
    assert.match(cdStoppedRes!, /⏸️ \*WA-Agent CLI is stopped\.\*/);

    // 4. /start activates CLI
    const startRes = await processIncomingMessage(ADMIN_JID, '/start');
    assert.match(startRes!, /🚀 \*WA-Agent CLI Started\*/);
    assert.match(startRes!, /📁 \*Project\*:\s+Not selected/);
    assert.match(startRes!, /🧠 \*Agent\*:\s+Not selected/);

    // 5. /ls now works
    const lsActiveRes = await processIncomingMessage(ADMIN_JID, '/ls');
    assert.match(lsActiveRes!, /📁/);
  });
});
