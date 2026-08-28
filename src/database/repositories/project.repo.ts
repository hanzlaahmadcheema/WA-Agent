import path from 'node:path';
import crypto from 'node:crypto';
import { getDatabase, runTransaction } from '../connection.js';
import type { Project } from '../types.js';
import { getOrCreateProjectConfig } from './config.repo.js';

export function getProjectById(projectId: string): Project | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as unknown as Project | undefined;
}

export function getActiveProject(userId: string): Project | undefined {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM projects WHERE user_id = ? AND is_active = 1 LIMIT 1')
    .get(userId) as unknown as Project | undefined;
}

export function getUserProjects(userId: string): Project[] {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as unknown as Project[];
}

export function setActiveProject(userId: string, projectId: string): Project {
  const db = getDatabase();
  const now = Date.now();

  runTransaction(() => {
    db.prepare('UPDATE projects SET is_active = 0, updated_at = ? WHERE user_id = ?').run(
      now,
      userId
    );
    db.prepare('UPDATE projects SET is_active = 1, updated_at = ? WHERE id = ? AND user_id = ?').run(
      now,
      projectId,
      userId
    );
  });

  return getProjectById(projectId)!;
}

export function getOrCreateProject(
  userId: string,
  rootPath: string,
  projectName?: string,
  selectedAgent: string = 'claude'
): Project {
  const db = getDatabase();
  const normalizedRoot = path.resolve(rootPath);

  const existing = db
    .prepare('SELECT * FROM projects WHERE user_id = ? AND root_path = ?')
    .get(userId, normalizedRoot) as unknown as Project | undefined;

  if (existing) {
    return existing;
  }

  const name = projectName || path.basename(normalizedRoot) || 'project';
  const id = `proj_${crypto.randomBytes(4).toString('hex')}`;
  const now = Date.now();

  runTransaction(() => {
    const hasActive = getActiveProject(userId);
    const isActive = hasActive ? 0 : 1;

    db.prepare(`
      INSERT INTO projects (id, user_id, name, root_path, cwd, selected_agent, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, name, normalizedRoot, normalizedRoot, selectedAgent, isActive, now, now);

    // Initialize default project config
    getOrCreateProjectConfig(id);
  });

  return getProjectById(id)!;
}

export function updateProjectCwd(projectId: string, newCwd: string): void {
  const db = getDatabase();
  db.prepare('UPDATE projects SET cwd = ?, updated_at = ? WHERE id = ?').run(
    newCwd,
    Date.now(),
    projectId
  );
}

export function updateSelectedAgent(projectId: string, agentName: string): void {
  const db = getDatabase();
  db.prepare('UPDATE projects SET selected_agent = ?, updated_at = ? WHERE id = ?').run(
    agentName,
    Date.now(),
    projectId
  );
}
