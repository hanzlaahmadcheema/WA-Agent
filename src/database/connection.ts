import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let dbInstance: DatabaseSync | null = null;

export function initDatabase(dbPath: string): DatabaseSync {
  if (dbInstance) return dbInstance;

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // Performance & Concurrency Pragmas
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  // Execute Schema DDL
  const schemaSqlPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaSqlPath, 'utf8');
  db.exec(schemaSql);

  // Startup Crash Recovery
  // Transition any orphan in-flight tasks from prior crash to FAILED
  const now = Date.now();
  db.prepare(`
    UPDATE jobs
    SET status = 'FAILED',
        finished_at = ?,
        failure_reason = 'SERVER_RESTART',
        error_message = 'Process terminated abruptly due to host or daemon restart.'
    WHERE status IN ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED')
  `).run(now);

  dbInstance = db;
  return db;
}

export function getDatabase(): DatabaseSync {
  if (!dbInstance) {
    throw new Error('Database has not been initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function runTransaction<T>(fn: () => T): T {
  const db = getDatabase();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors if already aborted
    }
    throw err;
  }
}
