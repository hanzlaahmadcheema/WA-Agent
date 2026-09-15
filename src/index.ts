import dns from 'node:dns';
import { config } from './config.js';
import { initDatabase } from './database/connection.js';
import { startWhatsAppClient } from './whatsapp/client.js';
import { startHealthServer, registerWhatsAppStateProvider } from './health.js';
import { executeGracefulShutdown } from './shutdown.js';
import { logger } from './logger.js';

// Prioritize IPv4 to avoid ENETUNREACH errors on hosts without IPv6 routing when connecting to WhatsApp CDN
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

async function bootstrap() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       🤖 Claude Code WhatsApp Control Plane Daemon             ');
  console.log('═══════════════════════════════════════════════════════════════');

  logger.info(
    {
      adminPhone: config.ADMIN_PHONE_NUMBER,
      allowedRoots: config.ALLOWED_ROOTS,
      databasePath: config.DATABASE_PATH,
    },
    'daemon.startup'
  );

  console.log(`[Init] Initializing SQLite database at ${config.DATABASE_PATH}...`);
  initDatabase(config.DATABASE_PATH);
  console.log('[Init] Database ready (WAL mode + crash recovery executed).');

  console.log(`[Init] Allowed sandbox roots: ${config.ALLOWED_ROOTS.join(', ')}`);
  console.log(`[Init] Admin phone: ${config.ADMIN_PHONE_NUMBER}`);
  if (config.AUTHORIZED_PHONE_NUMBERS && config.AUTHORIZED_PHONE_NUMBERS.length > 0) {
    console.log(`[Init] Additional authorized phones: ${config.AUTHORIZED_PHONE_NUMBERS.join(', ')}`);
  }

  // Start HTTP health server
  if (config.HEALTH_ENABLED) {
    console.log(`[Init] Starting health server on port ${config.HEALTH_PORT}...`);
    await startHealthServer(config.HEALTH_PORT);
  }

  console.log('[Init] Starting WhatsApp connection...');
  const waAdapter = await startWhatsAppClient(config.BAILEYS_AUTH_DIR);
  registerWhatsAppStateProvider(() => waAdapter.getConnectionState());

  process.on('SIGINT', async () => {
    await executeGracefulShutdown('SIGINT');
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await executeGracefulShutdown('SIGTERM');
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  logger.fatal({ error: err.message, stack: err.stack }, 'daemon.fatal_error');
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
