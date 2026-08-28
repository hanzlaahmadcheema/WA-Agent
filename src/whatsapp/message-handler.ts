import type { proto } from '@whiskeysockets/baileys';
import { processIncomingMessage } from '../router/command-router.js';

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

export async function handleInboundWhatsAppMessage(
  sock: any,
  msg: proto.IWebMessageInfo
): Promise<void> {
  // Ignore status broadcasts and outbound messages sent by bot
  if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') {
    return;
  }

  const senderJid = msg.key.participant || msg.key.remoteJid;
  if (!senderJid) return;

  const text = extractMessageText(msg.message);
  if (!text) return;

  const pushName = msg.pushName || undefined;

  try {
    const replyText = await processIncomingMessage(senderJid, text, pushName);
    if (replyText) {
      await sock.sendMessage(msg.key.remoteJid, { text: replyText }, { quoted: msg });
    }
  } catch (err: any) {
    console.error(`[WhatsApp Error] Failed to process message from ${senderJid}:`, err);
    await sock.sendMessage(
      msg.key.remoteJid,
      {
        text: `❌ *ERR_INTERNAL*: Failed to process request.\n👉 ${err.message || 'Unknown error'}`,
      },
      { quoted: msg }
    );
  }
}
