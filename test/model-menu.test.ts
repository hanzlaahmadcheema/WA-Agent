import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase } from '../src/database/connection.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { fetchModelsForAgent } from '../src/agents/model-fetcher.js';
import { getOrCreateProjectConfig } from '../src/database/repositories/config.repo.js';
import { getActiveProject } from '../src/database/repositories/project.repo.js';

const TEST_DB = path.resolve('./data/test_model_menu.db');
const TEST_JID = '923124706501@s.whatsapp.net';

test('Model Fetcher & Interactive Menu Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);

  await suite.test('1. fetchModelsForAgent returns available models per agent', async () => {
    const agyModels = await fetchModelsForAgent('antigravity');
    assert.ok(agyModels.length >= 4);
    assert.ok(agyModels.some((m) => m.id.includes('gemini') || m.id.includes('claude')));

    const claudeModels = await fetchModelsForAgent('claude');
    assert.ok(claudeModels.some((m) => m.id.includes('sonnet')));

    const opencodeModels = await fetchModelsForAgent('opencode');
    assert.ok(opencodeModels.length >= 2);
  });

  await suite.test('2. /model without args presents numbered options menu', async () => {
    await processIncomingMessage(TEST_JID, '/start');
    await processIncomingMessage(TEST_JID, '/project select WA-Agent');
    await processIncomingMessage(TEST_JID, '/agent select antigravity');

    const modelMenu = await processIncomingMessage(TEST_JID, '/model');
    assert.match(String(modelMenu), /Select AI Model/);
    assert.match(String(modelMenu), /Current Model/);
    assert.match(String(modelMenu), /Available Models/);
    assert.match(String(modelMenu), /1\./);
    assert.match(String(modelMenu), /Reply with 1 to/);
  });

  await suite.test('3. Replying with a number selects model and updates project config', async () => {
    const selectRes = await processIncomingMessage(TEST_JID, '1');
    assert.match(String(selectRes), /Execution Model Updated/);

    const proj = getActiveProject(TEST_JID);
    assert.ok(proj);
    const cfg = getOrCreateProjectConfig(proj.id);
    assert.ok(cfg.model);
    assert.notEqual(cfg.model, '');
  });

  await suite.test('4. Menu displays active model and option 10 triggers /model', async () => {
    const menuRes = await processIncomingMessage(TEST_JID, '/menu');
    assert.match(String(menuRes), /🎛️ \*Model\*/);
    assert.match(String(menuRes), /🔟 🎛️ \*Choose Model\*/);

    // Reply 10 from menu
    const modelRes = await processIncomingMessage(TEST_JID, '10');
    assert.match(String(modelRes), /Select AI Model/);
  });

  await suite.test('5. Friendly keyword "model" or "models" opens model menu without slash', async () => {
    const keywordRes = await processIncomingMessage(TEST_JID, 'model');
    assert.match(String(keywordRes), /Select AI Model/);
  });
});
