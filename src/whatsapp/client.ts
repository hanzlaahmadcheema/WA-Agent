import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'node:path';
import { handleInboundWhatsAppMessage } from './message-handler.js';
import { setJobNotificationHandler } from '../jobs/job-manager.js';

export async function startWhatsAppClient(authDir: string = './auth_info_baileys') {
  const { state, saveCreds } = await useMultiFileAuthState(path.resolve(authDir));
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: true,
  });

  // Link background job async notifications to WhatsApp chat
  setJobNotificationHandler(async (userId: string, message: string) => {
    try {
      await sock.sendMessage(userId, { text: message });
    } catch (err: any) {
      console.error(`[WhatsApp] Failed to push notification to ${userId}:`, err.message);
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📲 Scan this QR code in WhatsApp to link your device:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[WhatsApp] Connection closed (code ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        startWhatsAppClient(authDir).catch((err) => {
          console.error('[WhatsApp] Reconnection failed:', err);
        });
      } else {
        console.log('[WhatsApp] Logged out. Delete auth folder to re-scan QR code.');
      }
    } else if (connection === 'open') {
      console.log('\n✅ [WhatsApp] Connected successfully! Control plane is live.');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (event) => {
    if (event.type === 'notify') {
      for (const msg of event.messages) {
        await handleInboundWhatsAppMessage(sock, msg);
      }
    }
  });

  return sock;
}
