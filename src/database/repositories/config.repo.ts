import { getDatabase } from '../connection.js';
import type { ProjectConfig } from '../types.js';
import { config as appConfig } from '../../config.js';

export function getProjectConfig(projectId: string): ProjectConfig | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM project_configs WHERE project_id = ?').get(projectId) as unknown as
    | ProjectConfig
    | undefined;
}

export function getOrCreateProjectConfig(projectId: string): ProjectConfig {
  const db = getDatabase();
  const existing = getProjectConfig(projectId);
  if (existing) return existing;

  const now = Date.now();
  db.prepare(`
    INSERT INTO project_configs (
      project_id, model, permission_mode, allowed_tools, denied_tools,
      agent_output_format, max_turns, max_budget_usd, worktree_enabled,
      worktree_branch, mcp_config_path, render_mode, render_show_diff,
      render_max_excerpt_lines, render_notify_progress, updated_at
    ) VALUES (
      ?, ?, 'plan', '[]', '[]',
      'json', 10, NULL, 0,
      NULL, NULL, 'compact', 1,
      15, 0, ?
    )
  `).run(projectId, appConfig.DEFAULT_MODEL, now);

  return getProjectConfig(projectId)!;
}

export function updateProjectConfig(
  projectId: string,
  updates: Partial<Omit<ProjectConfig, 'project_id' | 'updated_at'>>
): ProjectConfig {
  const db = getDatabase();
  getOrCreateProjectConfig(projectId);

  const keys = Object.keys(updates) as (keyof typeof updates)[];
  if (keys.length === 0) return getProjectConfig(projectId)!;

  const setClauses = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (updates as any)[k]);
  values.push(Date.now(), projectId);

  db.prepare(`
    UPDATE project_configs
    SET ${setClauses}, updated_at = ?
    WHERE project_id = ?
  `).run(...values);

  return getProjectConfig(projectId)!;
}
