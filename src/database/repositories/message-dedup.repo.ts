import { getDatabase } from '../connection.js';

/**
 * Attempts to record an incoming WhatsApp message ID atomically.
 * Returns true if the message is fresh (inserted successfully).
 * Returns false if the message ID was already processed (duplicate).
 */
export function trackInboundMessage(messageId: string, senderJid: string): boolean {
  const db = getDatabase();
  const now = Date.now();

  try {
    const result = db.prepare(`
      INSERT INTO processed_messages (message_id, sender_jid, processed_at)
      VALUES (?, ?, ?)
    `).run(messageId, senderJid, now);

    return Number(result.changes) > 0;
  } catch (err: any) {
    if (err.code === 'ERR_SQLITE_ERROR' && String(err.message).includes('UNIQUE')) {
      return false; // Duplicate message ID
    }
    throw err;
  }
}

/**
 * Prunes messages older than the specified retention period (default: 24h)
 */
export function pruneOldMessages(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const db = getDatabase();
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare('DELETE FROM processed_messages WHERE processed_at < ?').run(cutoff);
  return Number(result.changes);
}
