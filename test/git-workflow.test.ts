import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { initDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { config } from '../src/config.js';

const TEST_DB = path.resolve('./data/test_git_workflow.db');
const TEST_JID = '923124706501@s.whatsapp.net';
const TEMP_GIT_REPO = path.resolve('./data/test_git_repo');

test('Git Workflow & Shortcuts Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);

  // Setup temporary git repo inside allowed root
  if (fs.existsSync(TEMP_GIT_REPO)) {
    fs.rmSync(TEMP_GIT_REPO, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_GIT_REPO, { recursive: true });
  execSync('git init -b main', { cwd: TEMP_GIT_REPO });
  execSync('git config user.name "Test User"', { cwd: TEMP_GIT_REPO });
  execSync('git config user.email "test@example.com"', { cwd: TEMP_GIT_REPO });

  // Initial commit
  fs.writeFileSync(path.join(TEMP_GIT_REPO, 'README.md'), '# Test Project\n');
  execSync('git add README.md && git commit -m "Initial commit"', { cwd: TEMP_GIT_REPO });

  await suite.test('1. Initialize CLI and navigate to test repository', async () => {
    await processIncomingMessage(TEST_JID, '/start');
    const cdRes = await processIncomingMessage(TEST_JID, `/cd ${TEMP_GIT_REPO}`);
    assert.match(String(cdRes), /test_git_repo/);
  });

  await suite.test('2. /git status and clean /diff', async () => {
    const statusRes = await processIncomingMessage(TEST_JID, '/status');
    assert.match(String(statusRes), /System Status/);

    const gitStatusRes = await processIncomingMessage(TEST_JID, '/git status');
    assert.match(String(gitStatusRes), /Git Repository Status/);
    assert.match(String(gitStatusRes), /main/);

    const diffRes = await processIncomingMessage(TEST_JID, '/diff');
    assert.match(String(diffRes), /Git Status: Clean/);
  });

  await suite.test('3. Detect modified files in /diff', async () => {
    fs.writeFileSync(path.join(TEMP_GIT_REPO, 'feature.ts'), 'export const hello = "world";\n');

    const diffRes = await processIncomingMessage(TEST_JID, '/diff');
    assert.match(String(diffRes), /Git Diffs & Changes/);
    assert.match(String(diffRes), /feature\.ts/);
  });

  await suite.test('4. Commit changes with /commit <message>', async () => {
    // Empty message should fail
    const emptyRes = await processIncomingMessage(TEST_JID, '/commit');
    assert.match(String(emptyRes), /Commit message is required/);

    // Valid commit
    const commitRes = await processIncomingMessage(TEST_JID, '/commit "Add feature module"');
    assert.match(String(commitRes), /Git Commit Created/);
    assert.match(String(commitRes), /Add feature module/);

    // Status is clean again
    const cleanDiff = await processIncomingMessage(TEST_JID, '/diff');
    assert.match(String(cleanDiff), /Git Status: Clean/);
  });

  await suite.test('5. View commit history with /git log', async () => {
    const logRes = await processIncomingMessage(TEST_JID, '/git log');
    assert.match(String(logRes), /Recent Commits/);
    assert.match(String(logRes), /Add feature module/);
    assert.match(String(logRes), /Initial commit/);
  });

  await suite.test('6. Friendly keyword "diff" works without leading slash', async () => {
    fs.appendFileSync(path.join(TEMP_GIT_REPO, 'README.md'), 'Extra notes\n');
    const diffRes = await processIncomingMessage(TEST_JID, 'diff');
    assert.match(String(diffRes), /Git Diffs & Changes/);
    assert.match(String(diffRes), /README\.md/);
  });

  // Cleanup
  if (fs.existsSync(TEMP_GIT_REPO)) {
    fs.rmSync(TEMP_GIT_REPO, { recursive: true, force: true });
  }
});
