import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { initDatabase } from '../src/database/connection.js';
import {
  executeMessagePipeline,
  registerSelfIdentity,
  isSelfChat,
} from '../src/whatsapp/message-pipeline.js';
import {
  markMessageAsSentByAgent,
  isMessageSentByAgent,
  sendWithRetry,
} from '../src/whatsapp/outbound-sender.js';
import { config } from '../src/config.js';
import type { proto } from '@whiskeysockets/baileys';

const TEST_DB = path.resolve('./data/test_self_chat.db');
const BOT_PHONE = '923124706501';
const BOT_LID = '244410113613956@lid';
const BOT_JID = `${BOT_PHONE}@s.whatsapp.net`;
const THIRD_PARTY_JID = '923266900001@s.whatsapp.net';

test('Self-Chat and Echo Prevention Suite', async (suite) => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  initDatabase(TEST_DB);

  registerSelfIdentity(BOT_PHONE);
  registerSelfIdentity(BOT_LID);

  await suite.test('1. Identity verification: isSelfChat recognizes bot identifiers', () => {
    assert.equal(isSelfChat(BOT_PHONE), true);
    assert.equal(isSelfChat(BOT_JID), true);
    assert.equal(isSelfChat(BOT_LID), true);
    assert.equal(isSelfChat('244410113613956'), true);

    // Third party
    assert.equal(isSelfChat(THIRD_PARTY_JID), false);
    assert.equal(isSelfChat('923266900001'), false);
  });

  await suite.test('2. Self-chat message via CLI (fromMe: true, to self) is processed', async () => {
    const rawMsg: proto.IWebMessageInfo = {
      key: {
        id: 'SELF_CLI_MSG_1',
        remoteJid: BOT_JID,
        fromMe: true,
      },
      message: {
        conversation: '/status',
      },
    };

    const result = await executeMessagePipeline(rawMsg);
    assert.equal(result.shouldReply, true);
    assert.match(result.replyText!, /System Status/i);
  });

  await suite.test('3. Outbound message to third party (fromMe: true, to someone else) is ignored', async () => {
    const rawMsg: proto.IWebMessageInfo = {
      key: {
        id: 'OUTBOUND_THIRD_PARTY_1',
        remoteJid: THIRD_PARTY_JID,
        fromMe: true,
      },
      message: {
        conversation: '/status',
      },
    };

    const result = await executeMessagePipeline(rawMsg);
    assert.equal(result.shouldReply, false);
    assert.equal(result.ignoredReason, 'Outbound message to third party');
  });

  await suite.test('4. Message sent by agent itself is tracked and prevented from looping', async () => {
    const agentMsgId = 'AGENT_OUTBOUND_ECHO_99';
    markMessageAsSentByAgent(agentMsgId);

    assert.equal(isMessageSentByAgent(agentMsgId), true);

    const echoMsg: proto.IWebMessageInfo = {
      key: {
        id: agentMsgId,
        remoteJid: BOT_JID,
        fromMe: true,
      },
      message: {
        conversation: '🤖 [Control Plane Status] Active Session: None',
      },
    };

    const result = await executeMessagePipeline(echoMsg);
    assert.equal(result.shouldReply, false);
    assert.equal(result.ignoredReason, 'Outbound or broadcast message');
  });

  await suite.test('5. sendWithRetry automatically registers sent message ID', async () => {
    const capturedId = 'GENERATED_OUTBOUND_MSG_42';
    const mockSend = async (jid: string, content: any) => {
      return {
        key: {
          id: capturedId,
          remoteJid: jid,
          fromMe: true,
        },
      };
    };

    const sent = await sendWithRetry(mockSend, BOT_JID, { text: 'Hello' });
    assert.equal(sent, true);
    assert.equal(isMessageSentByAgent(capturedId), true);
  });
});
