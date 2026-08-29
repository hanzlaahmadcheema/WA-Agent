import { logger } from './logger.js';
import { stopWhatsAppClient } from './whatsapp/client.js';
import { shutdownAllJobs } from './jobs/job-manager.js';
import { stopHealthServer } from './health.js';
import { closeDatabase } from './database/connection.js';

let shuttingDown = false;

export function isSystemShuttingDown(): boolean {
  return shuttingDown;
}

export async function executeGracefulShutdown(signal: string = 'SIGTERM'): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutdown.started');
  console.log(`\n🛑 [Shutdown] Received ${signal}. Executing graceful shutdown...`);

  try {
    // 1. Stop receiving new WhatsApp messages
    console.log('  1/4 Disconnecting WhatsApp transport...');
    await stopWhatsAppClient();

    // 2. Terminate all running agent process groups with SIGTERM (3s timeout) -> SIGKILL
    console.log('  2/4 Terminating active agent process groups...');
    await shutdownAllJobs(3000);

    // 3. Stop HTTP health server
    console.log('  3/4 Stopping health check server...');
    await stopHealthServer();

    // 4. Safely checkpoint and close SQLite database
    console.log('  4/4 Closing SQLite database...');
    closeDatabase();

    logger.info('shutdown.completed');
    console.log('✅ [Shutdown] Control plane daemon shut down cleanly.\n');
  } catch (err: any) {
    logger.error({ error: err.message }, 'shutdown.error');
    console.error('❌ [Shutdown] Error during shutdown:', err.message);
  }
}
