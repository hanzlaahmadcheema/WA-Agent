import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { ConnectionFSM, type ConnectionState } from './connection-fsm.js';
import { executeMessagePipeline, registerSelfIdentity } from './message-pipeline.js';
import { sendWithRetry } from './outbound-sender.js';
import { setJobNotificationHandler } from '../jobs/job-manager.js';
import { registerAdminLid, getAllAuthorizedPhones } from '../security/authorizer.js';
import { config } from '../config.js';

export interface WhatsAppAdapterOptions {
  authDir?: string;
  silent?: boolean;
}

export class WhatsAppAdapter {
  private socket: WASocket | null = null;
  private fsm: ConnectionFSM;
  private authDir: string;
  private silent: boolean;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isStopping = false;
  private pendingNotifications: Array<{ userId: string; text: string }> = [];

  constructor(options: WhatsAppAdapterOptions = {}) {
    this.authDir = path.resolve(options.authDir || './auth_info_baileys');
    this.silent = options.silent ?? false;
    this.fsm = new ConnectionFSM();

    // Wire JobManager notifications to WhatsApp
    setJobNotificationHandler(async (userId: string, message: string) => {
      await this.deliverNotification(userId, message);
    });
  }

  public getConnectionState(): ConnectionState {
    return this.fsm.getState();
  }

  public getFsm(): ConnectionFSM {
    return this.fsm;
  }

  public async start(): Promise<void> {
    this.isStopping = false;
    this.fsm.onConnecting();
    await this.initSocket();
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      try {
        this.socket.ev.removeAllListeners('connection.update');
        this.socket.ev.removeAllListeners('messages.upsert');
        this.socket.ev.removeAllListeners('creds.update');
        this.socket.end(undefined);
      } catch {
        // ignore close errors
      }
      this.socket = null;
    }

    this.fsm.onManualClose();
  }

  private async initSocket(): Promise<void> {
    if (this.isStopping) return;

    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({
      version: [2, 3000, 1015901307] as [number, number, number],
    }));

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
    });

    this.socket = sock;

    // Credentials persistence
    sock.ev.on('creds.update', saveCreds);

    // Connection lifecycle & FSM
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !this.silent) {
        console.log('\n📲 [WhatsApp] Scan this QR code to authenticate:');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.fsm.onOpen();
        if (sock.user) {
          registerSelfIdentity(sock.user.id);
          if ((sock.user as any).lid) {
            registerSelfIdentity((sock.user as any).lid);
          }
        }
        if (!this.silent) {
          console.log('\n✅ [WhatsApp] Connected successfully! Control plane is live.');
        }

        // Proactively resolve admin and authorized WhatsApp identities (both phone JID and LID)
        try {
          for (const phone of getAllAuthorizedPhones()) {
            const results = await sock.onWhatsApp(phone);
            if (results && results.length > 0) {
              const info = results[0];
              if (info.lid && typeof info.lid === 'string') {
                registerAdminLid(info.lid);
                if (!this.silent) {
                  console.log(`[WhatsApp] Admin/Authorized LID discovered for ${phone}: ${info.lid}`);
                }
              }
            }
          }
        } catch (err: any) {
          if (!this.silent) {
            console.warn(`[WhatsApp] Notice: Could not resolve admin/authorized LID on startup: ${err.message}`);
          }
        }

        await this.flushPendingNotifications();
      } else if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const closeResult = this.fsm.onClose(statusCode);

        if (!this.silent) {
          console.log(
            `[WhatsApp] Connection closed (code ${statusCode ?? 'unknown'}). State: ${closeResult.nextState}`
          );
        }

        // Clean old listeners to prevent leaks
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('messages.upsert');
        sock.ev.removeAllListeners('creds.update');
        this.socket = null;

        if (closeResult.isLoggedOut) {
          if (!this.silent) {
            console.warn('⚠️ [WhatsApp] Logged out from device. Resetting authentication directory...');
          }
          try {
            fs.rmSync(this.authDir, { recursive: true, force: true });
          } catch (e: any) {
            console.error('[WhatsApp] Failed to clear auth directory:', e.message);
          }
          return;
        }

        if (closeResult.nextState === 'RECONNECTING' && !this.isStopping) {
          const delay = closeResult.delayMs || 1000;
          if (!this.silent) {
            console.log(`[WhatsApp] Reconnecting in ${delay}ms (attempt #${this.fsm.getAttempts()})...`);
          }

          this.reconnectTimer = setTimeout(() => {
            this.initSocket().catch((err) => {
              console.error('[WhatsApp] Reconnection error:', err.message);
            });
          }, delay);
        }
      }
    });

    // Inbound Message Pipeline
    sock.ev.on('messages.upsert', async (event) => {
      if (event.type !== 'notify') return;

      for (const msg of event.messages) {
        try {
          const result = await executeMessagePipeline(msg, async (phone) => {
            const res = await sock.onWhatsApp(phone);
            const lid = res?.[0]?.lid;
            return typeof lid === 'string' ? lid : undefined;
          });
          if (result.shouldReply && result.recipientJid) {
            if (result.media) {
              if (result.media.image) {
                await sendWithRetry(
                  (jid, content, opt) => sock.sendMessage(jid, content, opt),
                  result.recipientJid,
                  { image: result.media.image, caption: result.media.caption || result.replyText },
                  { quoted: msg }
                );
              } else if (result.media.document) {
                await sendWithRetry(
                  (jid, content, opt) => sock.sendMessage(jid, content, opt),
                  result.recipientJid,
                  {
                    document: result.media.document,
                    mimetype: result.media.mimetype || 'application/octet-stream',
                    fileName: result.media.fileName || 'file',
                    caption: result.media.caption || result.replyText,
                  },
                  { quoted: msg }
                );
              }
            } else if (result.replyText) {
              await sendWithRetry(
                (jid, content, opt) => sock.sendMessage(jid, content, opt),
                result.recipientJid,
                { text: result.replyText },
                { quoted: msg }
              );
            }
          }
        } catch (err: any) {
          console.error('[WhatsApp] Unexpected error handling message:', err.message);
        }
      }
    });
  }

  private async deliverNotification(userId: string, message: string): Promise<void> {
    if (this.socket && this.fsm.getState() === 'OPEN') {
      const sent = await sendWithRetry(
        (jid, content) => this.socket!.sendMessage(jid, content),
        userId,
        { text: message }
      );
      if (!sent) {
        this.pendingNotifications.push({ userId, text: message });
      }
    } else {
      // Queue notification to dispatch when socket re-opens
      this.pendingNotifications.push({ userId, text: message });
    }
  }

  private async flushPendingNotifications(): Promise<void> {
    if (!this.socket || this.fsm.getState() !== 'OPEN') return;

    while (this.pendingNotifications.length > 0) {
      const item = this.pendingNotifications.shift();
      if (item) {
        await sendWithRetry(
          (jid, content) => this.socket!.sendMessage(jid, content),
          item.userId,
          { text: item.text }
        );
      }
    }
  }
}
