import type { proto } from '@whiskeysockets/baileys';
import { processIncomingMessage } from '../router/command-router.js';
import { authorizeUser } from '../security/authorizer.js';
import { trackInboundMessage } from '../database/repositories/message-dedup.repo.js';
import { UnauthorizedError, RateLimitedError } from '../router/errors.js';
import { LIMITS } from '../security/limits.js';
import { checkAndRecordRateLimit } from '../security/rate-limiter.js';

export interface PipelineResult {
  shouldReply: boolean;
  replyText?: string;
  recipientJid?: string;
  isDuplicate?: boolean;
  isUnauthorized?: boolean;
  ignoredReason?: string;
}

export function extractMessageText(message: proto.IMessage | null | undefined): string | null {
  if (!message) return null;

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

/**
 * Deterministic message processing pipeline:
 * 1. Normalize message & sender
 * 2. Filter group chats (@g.us)
 * 3. Authorize sender JID BEFORE parsing
 * 4. Deduplicate message ID
 * 5. Route command & generate reply
 */
export async function executeMessagePipeline(
  msg: proto.IWebMessageInfo
): Promise<PipelineResult> {
  // 1. Sanity & Malformed Message Checks
  if (!msg || !msg.key) {
    return { shouldReply: false, ignoredReason: 'Malformed message (missing key)' };
  }

  // Ignore status broadcasts and outbound messages sent by self
  if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') {
    return { shouldReply: false, ignoredReason: 'Outbound or broadcast message' };
  }

  // 2. Ignore group chats
  if (msg.key.remoteJid?.endsWith('@g.us')) {
    return { shouldReply: false, ignoredReason: 'Group messages not supported' };
  }

  // Identify sender JID
  const senderJid = msg.key.participant || msg.key.remoteJid;
  if (!senderJid) {
    return { shouldReply: false, ignoredReason: 'Unable to determine sender JID' };
  }

  const pushName = msg.pushName || undefined;

  // 3. Authorization Check BEFORE parsing or command routing
  try {
    authorizeUser(senderJid, pushName);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return {
        shouldReply: true,
        recipientJid: msg.key.remoteJid!,
        replyText: '🛑 *Access Denied*: Unauthorized sender.',
        isUnauthorized: true,
      };
    }
    return { shouldReply: false, ignoredReason: 'Authorization check failed' };
  }

  // 4. Message Deduplication Check
  const messageId = msg.key.id;
  if (messageId) {
    const isFresh = trackInboundMessage(messageId, senderJid);
    if (!isFresh) {
      return {
        shouldReply: false,
        isDuplicate: true,
        ignoredReason: `Duplicate message ID: ${messageId}`,
      };
    }
  }

  // 5. Extract Text & Command Routing
  const text = extractMessageText(msg.message);
  if (!text || !text.trim()) {
    return { shouldReply: false, ignoredReason: 'No text content' };
  }

  // 5.1 Enforce maximum message length
  if (text.length > LIMITS.MAX_MESSAGE_CHARS) {
    return {
      shouldReply: true,
      recipientJid: msg.key.remoteJid!,
      replyText: `❌ *ERR_INVALID_ARG*: Message exceeds maximum allowed size of ${LIMITS.MAX_MESSAGE_CHARS.toLocaleString()} characters.\n👉 Shorten your message.`,
    };
  }

  // 5.2 Enforce inbound message rate limit
  try {
    checkAndRecordRateLimit(senderJid, 'inbound');
  } catch (err: any) {
    if (err instanceof RateLimitedError) {
      return {
        shouldReply: true,
        recipientJid: msg.key.remoteJid!,
        replyText: err.toWhatsApp(),
      };
    }
  }

  // Only route messages that start with / or are numeric selections
  const trimmed = text.trim();
  if (!trimmed.startsWith('/') && !/^\d+$/.test(trimmed)) {
    return { shouldReply: false, ignoredReason: 'Non-command text' };
  }

  // 6. Execute Command via Router
  const replyText = await processIncomingMessage(senderJid, trimmed, pushName);
  if (!replyText) {
    return { shouldReply: false, ignoredReason: 'Command returned empty reply' };
  }

  return {
    shouldReply: true,
    recipientJid: msg.key.remoteJid!,
    replyText,
  };
}
