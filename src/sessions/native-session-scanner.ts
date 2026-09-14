import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SUPPORTED_AGENTS } from '../commands/agent.cmd.js';

export interface NativeChat {
  agent: string;          // e.g. 'antigravity' | 'codex' | 'opencode' | 'copilot' | 'claude'
  agentLabel: string;     // e.g. 'Antigravity' | 'Codex CLI'
  id: string;             // conversation_id / thread_id / sessionID
  title: string;          // brief topic / title
  updatedAt: Date;        // last updated timestamp
  workspace?: string;     // associated directory if known
  turns?: number;         // number of turns/steps if known
}

function getHomeDirs(): string[] {
  const dirs = new Set<string>();
  if (process.env.USER_HOME) dirs.add(process.env.USER_HOME);
  dirs.add('/home/hanzlaahmad');
  dirs.add('/var/lib/wa-agent');
  return Array.from(dirs).filter((d) => fs.existsSync(d));
}

export function scanAntigravityChats(limit: number = 10): NativeChat[] {
  const chats: NativeChat[] = [];
  const seenIds = new Set<string>();

  for (const home of getHomeDirs()) {
    const dbPath = path.join(home, '.gemini/antigravity-cli/conversation_summaries.db');
    if (!fs.existsSync(dbPath)) continue;

    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, preview, step_count, last_modified_time, workspace_uris
           FROM conversation_summaries
           ORDER BY last_modified_time DESC
           LIMIT ?`
        )
        .all(limit) as Array<{
        conversation_id: string;
        preview: string | null;
        step_count: number | null;
        last_modified_time: string;
        workspace_uris: string | null;
      }>;

      for (const row of rows) {
        if (!row.conversation_id || seenIds.has(row.conversation_id)) continue;
        seenIds.add(row.conversation_id);

        let ws = '';
        if (row.workspace_uris) {
          try {
            const parsed = JSON.parse(row.workspace_uris);
            if (Array.isArray(parsed) && parsed[0]) {
              ws = parsed[0].replace(/^file:\/\//, '');
            }
          } catch {}
        }

        const title = (row.preview || '').trim() || 'Antigravity Session';
        chats.push({
          agent: 'antigravity',
          agentLabel: 'Antigravity',
          id: row.conversation_id,
          title,
          updatedAt: new Date(row.last_modified_time || Date.now()),
          workspace: ws,
          turns: row.step_count || undefined,
        });
      }
    } catch {
      // Ignore database access or locked errors gracefully
    }
  }

  return chats;
}

export function scanOpenCodeChats(limit: number = 10): NativeChat[] {
  const chats: NativeChat[] = [];
  const seenIds = new Set<string>();

  for (const home of getHomeDirs()) {
    const dbPath = path.join(home, '.local/share/opencode/opencode.db');
    if (!fs.existsSync(dbPath)) continue;

    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT id, title, directory, time_updated
           FROM session
           ORDER BY time_updated DESC
           LIMIT ?`
        )
        .all(limit) as Array<{
        id: string;
        title: string | null;
        directory: string | null;
        time_updated: number;
      }>;

      for (const row of rows) {
        if (!row.id || seenIds.has(row.id)) continue;
        seenIds.add(row.id);

        chats.push({
          agent: 'opencode',
          agentLabel: 'OpenCode',
          id: row.id,
          title: (row.title || '').trim() || 'OpenCode Session',
          updatedAt: new Date(row.time_updated),
          workspace: row.directory || undefined,
        });
      }
    } catch {
      // Ignore database access or locked errors gracefully
    }
  }

  return chats;
}

export function scanCodexChats(limit: number = 10): NativeChat[] {
  const chats: NativeChat[] = [];
  const seenIds = new Set<string>();

  for (const home of getHomeDirs()) {
    const indexPath = path.join(home, '.codex/session_index.jsonl');
    if (!fs.existsSync(indexPath)) continue;

    try {
      const content = fs.readFileSync(indexPath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      for (const rawLine of lines.slice(-limit * 2).reverse()) {
        try {
          const item = JSON.parse(rawLine);
          if (item.id && !seenIds.has(item.id)) {
            seenIds.add(item.id);
            chats.push({
              agent: 'codex',
              agentLabel: 'Codex CLI',
              id: item.id,
              title: (item.thread_name || '').trim() || 'Codex Thread',
              updatedAt: new Date(item.updated_at || Date.now()),
            });
            if (chats.length >= limit) break;
          }
        } catch {}
      }
    } catch {
      // Ignore read errors
    }
  }

  return chats;
}

export function scanCopilotChats(limit: number = 10): NativeChat[] {
  const chats: NativeChat[] = [];
  const seenIds = new Set<string>();

  for (const home of getHomeDirs()) {
    const baseDir = path.join(home, '.copilot/session-state');
    if (!fs.existsSync(baseDir)) continue;

    try {
      const entries = fs.readdirSync(baseDir);
      for (const entry of entries) {
        if (seenIds.has(entry)) continue;
        const fullDir = path.join(baseDir, entry);
        try {
          const stat = fs.statSync(fullDir);
          if (!stat.isDirectory()) continue;

          seenIds.add(entry);
          let title = 'Copilot Chat';
          let workspace = '';

          const wsPath = path.join(fullDir, 'workspace.yaml');
          if (fs.existsSync(wsPath)) {
            const yaml = fs.readFileSync(wsPath, 'utf8');
            const cwdMatch = yaml.match(/^cwd:\s*(.+)$/m);
            if (cwdMatch) workspace = cwdMatch[1].trim();
            const nameMatch = yaml.match(/^name:\s*(?:\|-?\s*)?([^\n]+)/m);
            if (nameMatch && nameMatch[1].trim()) title = nameMatch[1].trim();
          }

          chats.push({
            agent: 'copilot',
            agentLabel: 'GitHub Copilot',
            id: entry,
            title: title.slice(0, 50),
            updatedAt: stat.mtime,
            workspace: workspace || undefined,
          });
        } catch {}
      }
    } catch {
      // Ignore read errors
    }
  }

  chats.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return chats.slice(0, limit);
}

export function scanClaudeChats(limit: number = 10): NativeChat[] {
  const chats: NativeChat[] = [];
  const seenIds = new Set<string>();

  for (const home of getHomeDirs()) {
    const projectsDir = path.join(home, '.claude/projects');
    if (!fs.existsSync(projectsDir)) continue;

    try {
      const projects = fs.readdirSync(projectsDir);
      for (const proj of projects) {
        const projPath = path.join(projectsDir, proj);
        try {
          const stat = fs.statSync(projPath);
          if (!stat.isDirectory()) continue;

          const files = fs.readdirSync(projPath);
          for (const file of files) {
            if (!file.endsWith('.jsonl')) continue;
            const fullFile = path.join(projPath, file);
            try {
              const fileStat = fs.statSync(fullFile);
              const sessionId = file.replace(/\.jsonl$/, '');
              if (seenIds.has(sessionId)) continue;
              seenIds.add(sessionId);

              // Read first few lines for initial prompt
              let title = 'Claude Session';
              const head = fs.readFileSync(fullFile, { encoding: 'utf8', flag: 'r' }).slice(0, 2048);
              const lines = head.split('\n');
              for (const l of lines) {
                try {
                  const ev = JSON.parse(l);
                  if (ev.type === 'user' && ev.message?.content) {
                    title = typeof ev.message.content === 'string' ? ev.message.content : 'Claude Session';
                    break;
                  }
                } catch {}
              }

              chats.push({
                agent: 'claude',
                agentLabel: 'Claude Code',
                id: sessionId,
                title: title.slice(0, 50),
                updatedAt: fileStat.mtime,
              });
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  chats.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return chats.slice(0, limit);
}

/**
 * Scans all available native agent sessions across disk and returns them sorted by recency.
 */
export async function scanAllNativeChats(
  filterAgent?: string,
  limit: number = 15
): Promise<NativeChat[]> {
  const normAgent = filterAgent?.toLowerCase().trim();

  let chats: NativeChat[] = [];

  if (!normAgent || normAgent === 'antigravity' || normAgent === 'agy') {
    chats.push(...scanAntigravityChats(limit));
  }
  if (!normAgent || normAgent === 'opencode') {
    chats.push(...scanOpenCodeChats(limit));
  }
  if (!normAgent || normAgent === 'codex') {
    chats.push(...scanCodexChats(limit));
  }
  if (!normAgent || normAgent === 'copilot') {
    chats.push(...scanCopilotChats(limit));
  }
  if (!normAgent || normAgent === 'claude') {
    chats.push(...scanClaudeChats(limit));
  }

  // Sort by updatedAt descending
  chats.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return chats.slice(0, limit);
}
