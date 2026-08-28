import { config } from './config.js';
import { initDatabase, closeDatabase } from './database/connection.js';
import { startWhatsAppClient, stopWhatsAppClient } from './whatsapp/client.js';

async function bootstrap() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       🤖 Claude Code WhatsApp Control Plane Daemon             ');
  console.log('═══════════════════════════════════════════════════════════════');

  console.log(`[Init] Initializing SQLite database at ${config.DATABASE_PATH}...`);
  initDatabase(config.DATABASE_PATH);
  console.log('[Init] Database ready (WAL mode + crash recovery executed).');

  console.log(`[Init] Allowed sandbox roots: ${config.ALLOWED_ROOTS.join(', ')}`);
  console.log(`[Init] Admin phone: ${config.ADMIN_PHONE_NUMBER}`);

  console.log('[Init] Starting WhatsApp connection...');
  await startWhatsAppClient();

  const shutdown = async () => {
    console.log('\n[Shutdown] Gracefully shutting down daemon...');
    await stopWhatsAppClient();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
