import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import type { proto } from '@whiskeysockets/baileys';
import { initDatabase } from '../src/database/connection.js';
import { executeMessagePipeline } from '../src/whatsapp/message-pipeline.js';
import { processIncomingMessage } from '../src/router/command-router.js';
import { registerAgentDriver } from '../src/agents/agent-registry.js';
import { AntigravityDriver } from '../src/agents/drivers/antigravity.driver.js';
import type { AgentRunOptions } from '../src/agents/agent-driver.interface.js';

const TEST_DB = path.resolve('./data/test_natural_media.db');
const TEST_JID = '923124706501@s.whatsapp.net';

class FastMockAntigravityDriver extends AntigravityDriver {
  buildCommandArgs(options: AgentRunOptions): string[] {
    return [process.execPath, '-e', 'console.log("Mock antigravity output")'];
  }
}

test('Natural Conversation & Multimodal Media Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);

  registerAgentDriver(new FastMockAntigravityDriver());

  await suite.test('1. Non-command text is ignored when no session is active', async () => {
    const rawMsg: proto.IWebMessageInfo = {
      key: { id: 'MSG_PLAIN_1', remoteJid: TEST_JID },
      message: { conversation: 'Just some ordinary text conversation' },
    };

    const res = await executeMessagePipeline(rawMsg);
    assert.equal(res.shouldReply, false);
    assert.equal(res.ignoredReason, 'Non-command text');
  });

  await suite.test('2. Natural Conversation Mode routes plain text when session is active', async () => {
    // Setup active session
    await processIncomingMessage(TEST_JID, '/start');
    await processIncomingMessage(TEST_JID, '/project select WA-Agent');
    await processIncomingMessage(TEST_JID, '/agent select antigravity');
    await processIncomingMessage(TEST_JID, '/session new natural-mode-session');

    // Send plain conversational message without /run prefix
    const rawMsg: proto.IWebMessageInfo = {
      key: { id: 'MSG_PLAIN_2', remoteJid: TEST_JID },
      message: { conversation: 'Explain how authentication works in this repository' },
    };

    const res = await executeMessagePipeline(rawMsg);
    assert.equal(res.shouldReply, true);
    assert.match(res.replyText!, /Job #\d+ Launched|Task #\d+ Started/);
  });

  await suite.test('3. Multimodal: Image attachments are downloaded, saved, and queued', async () => {
    await processIncomingMessage(TEST_JID, '/session new image-test-session');
    const mockImageBuffer = Buffer.from('mock-png-binary-data');

    const imageMsg: proto.IWebMessageInfo = {
      key: { id: 'MSG_IMAGE_1', remoteJid: TEST_JID },
      message: {
        imageMessage: {
          caption: 'Review this error screenshot and fix it',
          mimetype: 'image/png',
        },
      },
    };

    const mockDownloader = async () => mockImageBuffer;

    const res = await executeMessagePipeline(imageMsg, undefined, mockDownloader);
    assert.equal(res.shouldReply, true);
    assert.match(res.replyText!, /Job #\d+ Launched|Task #\d+ Started/);
  });

  await suite.test('4. Multimodal: Voice note transcribes or warns gracefully', async () => {
    const mockAudioBuffer = Buffer.from('mock-audio-data');

    const audioMsg: proto.IWebMessageInfo = {
      key: { id: 'MSG_AUDIO_1', remoteJid: TEST_JID },
      message: {
        audioMessage: {
          mimetype: 'audio/ogg',
        },
      },
    };

    const mockDownloader = async () => mockAudioBuffer;

    const res = await executeMessagePipeline(audioMsg, undefined, mockDownloader);
    assert.equal(res.shouldReply, true);
    // Since no API key is configured in test env, it returns friendly guidance
    assert.match(res.replyText!, /Voice Note Received/);
    assert.match(res.replyText!, /Could not transcribe audio|transcription engine/);
  });
});
