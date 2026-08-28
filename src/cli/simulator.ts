import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { config } from '../config.js';
import { initDatabase, closeDatabase } from '../database/connection.js';
import { processIncomingMessage } from '../router/command-router.js';
import { setJobNotificationHandler } from '../jobs/job-manager.js';

async function runSimulator() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('       📱 WhatsApp Control Plane — CLI Simulator               ');
  console.log('═══════════════════════════════════════════════════════════════');

  // Initialize SQLite database
  console.log(`[DB] Initializing database at ${config.DATABASE_PATH}...`);
  initDatabase(config.DATABASE_PATH);
  console.log('[DB] Database ready (WAL mode).');

  const simulatedPhone = config.ADMIN_PHONE_NUMBER;
  const simulatedJid = `${simulatedPhone}@s.whatsapp.net`;

  console.log(`[AUTH] Simulating authorized user: ${simulatedJid}`);
  console.log('[INFO] Type commands starting with / (e.g. /menu, /pwd, /ls, /run echo "hello")');
  console.log('[INFO] Type "exit" to quit.\n');

  // Set up background job notification callback
  setJobNotificationHandler((userId, message) => {
    console.log('\n────────────────── 🔔 ASYNC NOTIFICATION ──────────────────');
    console.log(message);
    console.log('───────────────────────────────────────────────────────────\n');
    rl.prompt(true);
  });

  const rl = readline.createInterface({ input, output });
  rl.setPrompt('WA-CLI > ');
  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === 'exit') {
      rl.close();
      return;
    }

    if (!trimmed) {
      rl.prompt();
      return;
    }

    try {
      const reply = await processIncomingMessage(simulatedJid, trimmed, 'Admin');
      if (reply) {
        console.log('\n' + reply + '\n');
      }
    } catch (err: any) {
      console.error('\n❌ Execution Error:', err.message, '\n');
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n[INFO] Closing simulator and database connection.');
    closeDatabase();
    process.exit(0);
  });
}

runSimulator().catch((err) => {
  console.error('Fatal error in simulator:', err);
  process.exit(1);
});
