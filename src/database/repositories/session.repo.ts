import crypto from 'node:crypto';
import { getDatabase, runTransaction } from '../connection.js';
import type { Session } from '../types.js';

export function getActiveSession(projectId: string): Session | undefined {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM sessions WHERE project_id = ? AND status = 'ACTIVE' LIMIT 1")
    .get(projectId) as unknown as Session | undefined;
}

export function getSessionById(sessionId: string): Session | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as unknown as Session | undefined;
}

export function getSessionByName(projectId: string, name: string): Session | undefined {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM sessions WHERE project_id = ? AND name = ?')
    .get(projectId, name) as unknown as Session | undefined;
}

export function getProjectSessions(projectId: string): Session[] {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY last_active_at DESC')
    .all(projectId) as unknown as Session[];
}

export function createSession(
  projectId: string,
  userId: string,
  name: string,
  agentName: string,
  workingDir: string
): Session {
  const db = getDatabase();
  const id = `sess_${crypto.randomBytes(4).toString('hex')}`;
  const now = Date.now();

  runTransaction(() => {
    // Close any currently active sessions for this project
    db.prepare("UPDATE sessions SET status = 'CLOSED', last_active_at = ? WHERE project_id = ? AND status = 'ACTIVE'").run(
      now,
      projectId
    );

    // Insert new active session
    db.prepare(`
      INSERT INTO sessions (
        id, project_id, user_id, name, agent_name,
        agent_session_ref, working_dir, status, turn_count,
        tokens_in, tokens_out, total_cost_usd, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'ACTIVE', 0, NULL, NULL, NULL, ?, ?)
    `).run(id, projectId, userId, name, agentName, workingDir, now, now);
  });

  return getSessionById(id)!;
}

export function resumeSession(projectId: string, sessionId: string): Session {
  const db = getDatabase();
  const now = Date.now();

  runTransaction(() => {
    db.prepare("UPDATE sessions SET status = 'CLOSED', last_active_at = ? WHERE project_id = ? AND status = 'ACTIVE'").run(
      now,
      projectId
    );
    db.prepare("UPDATE sessions SET status = 'ACTIVE', last_active_at = ? WHERE id = ?").run(
      now,
      sessionId
    );
  });

  return getSessionById(sessionId)!;
}

export function closeActiveSession(projectId: string): void {
  const db = getDatabase();
  db.prepare("UPDATE sessions SET status = 'CLOSED', last_active_at = ? WHERE project_id = ? AND status = 'ACTIVE'").run(
    Date.now(),
    projectId
  );
}

export function renameSession(sessionId: string, newName: string): void {
  const db = getDatabase();
  db.prepare('UPDATE sessions SET name = ?, last_active_at = ? WHERE id = ?').run(
    newName,
    Date.now(),
    sessionId
  );
}

export function updateSessionMetrics(
  sessionId: string,
  turnsDelta: number,
  tokensInDelta: number | null,
  tokensOutDelta: number | null,
  costDelta: number | null
): void {
  const db = getDatabase();
  const current = getSessionById(sessionId);
  if (!current) return;

  const newTurns = current.turn_count + turnsDelta;
  const newTokensIn =
    tokensInDelta !== null ? (current.tokens_in || 0) + tokensInDelta : current.tokens_in;
  const newTokensOut =
    tokensOutDelta !== null ? (current.tokens_out || 0) + tokensOutDelta : current.tokens_out;
  const newCost =
    costDelta !== null ? (current.total_cost_usd || 0) + costDelta : current.total_cost_usd;

  db.prepare(`
    UPDATE sessions
    SET turn_count = ?, tokens_in = ?, tokens_out = ?, total_cost_usd = ?, last_active_at = ?
    WHERE id = ?
  `).run(newTurns, newTokensIn, newTokensOut, newCost, Date.now(), sessionId);
}
