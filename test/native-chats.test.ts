import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { scanAllNativeChats } from '../src/sessions/native-session-scanner.js';
import { getActiveSession } from '../src/database/repositories/session.repo.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';
import { setSelectionCache, getSelectionCache } from '../src/state/selection-cache.js';
import { config } from '../src/config.js';

const TEST_DB = path.resolve('./data/test_native_chats.db');
const ADMIN_JID = `${config.ADMIN_PHONE_NUMBER}@s.whatsapp.net`;

test('Native Desktop Chats Discovery & Resumption Suite', async (t) => {
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB);
  }
  initDatabase(TEST_DB);

  await t.test('1. Scanner returns available desktop sessions', async () => {
    const chats = await scanAllNativeChats(undefined, 10);
    assert.ok(Array.isArray(chats));
    if (chats.length > 0) {
      assert.ok(chats[0].id);
      assert.ok(chats[0].agent);
      assert.ok(chats[0].agentLabel);
      assert.ok(chats[0].title);
      assert.ok(chats[0].updatedAt instanceof Date);
    }
  });

  await t.test('2. /chats displays numbered list and sets selection cache', async () => {
    await processIncomingMessage(ADMIN_JID, '/start');
    const res = await processIncomingMessage(ADMIN_JID, '/chats');
    assert.ok(res);

    if (res.includes('No recent desktop chats found')) {
      assert.match(res, /No recent desktop chats found/);
    } else {
      assert.match(res, /Recent Desktop \/ Terminal Chats/);
      assert.match(res, /1\./);

      const cache = getSelectionCache(ADMIN_JID);
      assert.ok(cache);
      assert.strictEqual(cache?.source, 'NATIVE_CHAT_LIST');
      assert.ok(cache!.items.length > 0);
    }
  });

  await t.test('3. Select native chat via number shortcut connects chat to WhatsApp', async () => {
    setSelectionCache(ADMIN_JID, 'NATIVE_CHAT_LIST', '/home/hanzlaahmad/PersonalProjects/WA-Agent', [
      {
        index: 1,
        label: 'Test Mock Chat',
        value: 'mock-uuid-12345',
        type: 'native_chat',
        metadata: {
          agent: 'antigravity',
          agentLabel: 'Antigravity',
          title: 'Test Mock Chat',
          id: 'mock-uuid-12345',
          workspace: '/home/hanzlaahmad/PersonalProjects/WA-Agent',
        },
      },
    ]);

    const selectRes = await processIncomingMessage(ADMIN_JID, '1');
    assert.ok(selectRes);
    assert.match(selectRes, /✨ \*Desktop Chat Connected!\*/);
    assert.match(selectRes, /Antigravity/);
    assert.match(selectRes, /Test Mock Chat/);

    const project = getActiveProject(ADMIN_JID);
    assert.ok(project);
    const session = getActiveSession(project!.id);
    assert.ok(session);
    assert.strictEqual(session?.agent_session_ref, 'mock-uuid-12345');
    assert.strictEqual(session?.agent_name, 'antigravity');
  });

  await t.test('4. Filter /chats by specific agent', async () => {
    const agyRes = await processIncomingMessage(ADMIN_JID, '/chats antigravity');
    assert.ok(agyRes);
    if (!agyRes.includes('No recent desktop chats found')) {
      assert.match(agyRes, /Antigravity/);
    }
  });

  await t.test('5. Plain text "chats" or "chat" works without slash', async () => {
    const plainRes = await processIncomingMessage(ADMIN_JID, 'chats');
    assert.ok(plainRes);
    assert.ok(
      plainRes.includes('Recent Desktop / Terminal Chats') ||
      plainRes.includes('No recent desktop chats found')
    );
  });
});
