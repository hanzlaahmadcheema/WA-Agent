import type { CommandContext } from './types.js';
import {
  createSession,
  getProjectSessions,
  getActiveSession,
  getSessionByName,
  getSessionById,
  resumeSession,
  closeActiveSession,
  renameSession,
} from '../database/repositories/session.repo.js';
import {
  getOrCreateProject,
  setActiveProject,
  getProjectById,
  getUserProjects,
} from '../database/repositories/project.repo.js';
import {
  setSelectionCache,
  resolveSelectionIndex,
  type SelectionItem,
} from '../state/selection-cache.js';
import { isSessionLocked } from '../state/session-lock.js';
import {
  InvalidArgumentError,
  NotFoundError,
  JobCollisionError,
  NoActiveSessionError,
} from '../router/errors.js';
import { SUPPORTED_AGENTS } from './agent.cmd.js';
import { config } from '../config.js';
import { getDatabase } from '../database/connection.js';
import type { Session } from '../database/types.js';

export async function handleSession(ctx: CommandContext): Promise<string> {
  const { subcommand, args } = ctx.parsed;

  switch (subcommand) {
    case 'create':
    case 'new':
      return handleSessionCreate(ctx, args[0]);
    case 'list':
      return handleSessionList(ctx);
    case 'select':
    case 'resume':
      return handleSessionSelect(ctx, args[0]);
    case 'close':
      return handleSessionClose(ctx);
    case 'rename':
      return handleSessionRename(ctx, args[0]);
    case 'info':
    default:
      return handleSessionInfo(ctx);
  }
}

export function handleSessionInfo(ctx: CommandContext): string {
  if (!ctx.project) {
    return [
      '💬 *Session: Not created*',
      '',
      'Select a project first:',
      '  `/project select <path>`',
    ].join('\n');
  }

  const active = getActiveSession(ctx.project.id);
  const agentMeta = SUPPORTED_AGENTS.find((a) => a.name === ctx.project!.selected_agent);
  const agentDisplay = ctx.project.selected_agent && ctx.project.selected_agent !== 'none'
    ? (agentMeta?.label || ctx.project.selected_agent)
    : 'Not selected';

  if (!active) {
    return [
      '💬 *Session: Not created*',
      '',
      '*Current project:*',
      ctx.project.name,
      '',
      '*Agent:*',
      agentDisplay,
      '',
      'Create a session first:',
      '  `/session create [name]`',
      '',
      'Commands:',
      '  `/session create [name]`',
      '  `/session list`',
    ].join('\n');
  }

  const shortId = active.id.replace(/^sess_/, '');
  const sessionAgent = SUPPORTED_AGENTS.find((a) => a.name === active.agent_name)?.label || active.agent_name;

  return [
    '💬 *Sessions*',
    '',
    'Current:',
    `  #${shortId} (${active.name})`,
    `  Agent: ${sessionAgent}`,
    `  Project: ${ctx.project.name}`,
    `  Directory: ${active.working_dir}`,
    '',
    'Commands:',
    '  `/session create [name]`',
    '  `/session list`',
    '  `/session select <id>`',
    '  `/session info`',
    '  `/session rename <name>`',
    '  `/session close`',
  ].join('\n');
}

export function handleSessionCreate(ctx: CommandContext, name?: string): string {
  // Ensure project exists (fallback to default root to support non-interactive scripts / test runs)
  if (!ctx.project) {
    const defaultRoot = config.ALLOWED_ROOTS[0];
    ctx.project = getOrCreateProject(ctx.user.id, defaultRoot, undefined, config.DEFAULT_AGENT);
    setActiveProject(ctx.user.id, ctx.project.id);
  }

  const sessionName =
    name || `sess-${Math.random().toString(36).substring(2, 8)}`;

  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(sessionName)) {
    throw new InvalidArgumentError(
      'Session name must be alphanumeric, dashes, or underscores (1-40 chars).',
      'Example: /session create backend-refactor'
    );
  }

  const existing = getSessionByName(ctx.project.id, sessionName);
  if (existing) {
    throw new InvalidArgumentError(
      `Session "${sessionName}" already exists in this project.`,
      `Resume it with /session select ${sessionName} or choose a different name.`
    );
  }

  const effectiveAgent = (ctx.project.selected_agent && ctx.project.selected_agent !== 'none')
    ? ctx.project.selected_agent
    : config.DEFAULT_AGENT;

  ctx.project.selected_agent = effectiveAgent;

  const session = createSession(
    ctx.project.id,
    ctx.user.id,
    sessionName,
    effectiveAgent,
    ctx.project.root_path
  );

  const shortId = session.id.replace(/^sess_/, '');
  const agentMeta = SUPPORTED_AGENTS.find((a) => a.name === session.agent_name);
  const agentDisplay = agentMeta?.label || session.agent_name;

  return [
    '✨ *New Session Created*',
    '',
    `Session: #${shortId} (*${session.name}*)`,
    `Agent:   ${agentDisplay}`,
    `Project: ${ctx.project.name}`,
    'Directory:',
    ctx.project.root_path,
    '',
    'Ready.',
    '',
    'Run:',
    '/run <prompt>',
  ].join('\n');
}

export function handleSessionList(ctx: CommandContext): string {
  const db = getDatabase();
  const allSessions = db
    .prepare('SELECT s.*, p.name as project_name FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.user_id = ? ORDER BY s.last_active_at DESC')
    .all(ctx.user.id) as unknown as Array<Session & { project_name: string }>;

  if (allSessions.length === 0) {
    return [
      'ℹ️ *No sessions found.*',
      '',
      'Create one with:',
      '  `/session create [name]`',
    ].join('\n');
  }

  const selectionItems: SelectionItem[] = [];
  const lines: string[] = ['💬 *Your Sessions*', ''];

  allSessions.forEach((s, idx) => {
    const index = idx + 1;
    const isActive = s.status === 'ACTIVE' && ctx.project && ctx.project.id === s.project_id;
    const shortId = s.id.replace(/^sess_/, '');
    const agentMeta = SUPPORTED_AGENTS.find((a) => a.name === s.agent_name);
    const agentDisplay = agentMeta?.label || s.agent_name;

    selectionItems.push({
      index,
      label: s.name,
      value: s.id,
      type: 'session',
    });

    lines.push(
      `${isActive ? '▶' : ' '} #${shortId}  *${agentDisplay}*  ${s.project_name} (${s.name}) [${s.status}]`
    );
  });

  lines.push('', 'Use: `/session select <#id | n>`');

  setSelectionCache(ctx.user.id, 'SESSION_LIST', ctx.navCwd, selectionItems);

  return lines.join('\n');
}

export function handleSessionSelect(ctx: CommandContext, target?: string): string {
  if (!target) {
    throw new InvalidArgumentError(
      'Target session ID, name, or index required.',
      'Usage: /session select <id | index | name>'
    );
  }

  const cleanTarget = target.replace(/^#/, '');
  let sessionToResume: Session | undefined;

  // 1. Numeric index against selection cache
  if (/^\d+$/.test(cleanTarget)) {
    const index = parseInt(cleanTarget, 10);
    try {
      const item = resolveSelectionIndex(ctx.user.id, index, undefined, 'session');
      sessionToResume = getSessionById(item.value);
    } catch {
      // Fall through to query by ID or prefix
    }
  }

  // 2. Exact match or sess_ prefix match
  if (!sessionToResume) {
    sessionToResume =
      getSessionById(cleanTarget) ||
      getSessionById(`sess_${cleanTarget}`) ||
      (ctx.project ? getSessionByName(ctx.project.id, cleanTarget) : undefined);
  }

  // 3. Match across all user sessions by prefix
  if (!sessionToResume) {
    const db = getDatabase();
    sessionToResume = db
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND (id LIKE ? OR name = ?) LIMIT 1')
      .get(ctx.user.id, `%${cleanTarget}%`, cleanTarget) as Session | undefined;
  }

  if (!sessionToResume || sessionToResume.user_id !== ctx.user.id) {
    throw new NotFoundError(
      'Session',
      target,
      'Check existing sessions with /session list.'
    );
  }

  // Switch project if session belongs to another project
  if (!ctx.project || ctx.project.id !== sessionToResume.project_id) {
    const project = getProjectById(sessionToResume.project_id);
    if (project) {
      setActiveProject(ctx.user.id, project.id);
      ctx.project = project;
    }
  }

  const resumed = resumeSession(sessionToResume.project_id, sessionToResume.id);
  const shortId = resumed.id.replace(/^sess_/, '');
  const agentMeta = SUPPORTED_AGENTS.find((a) => a.name === resumed.agent_name);
  const agentDisplay = agentMeta?.label || resumed.agent_name;

  return [
    '💬 *Session selected*',
    '',
    `Session: #${shortId} (*${resumed.name}*)`,
    `Agent:   ${agentDisplay}`,
    `Project: ${ctx.project ? ctx.project.name : 'Active'}`,
    `Turns:   ${resumed.turn_count}`,
    '',
    'Ready.',
    '',
    'Run:',
    '/run <prompt>',
  ].join('\n');
}

export function handleSessionClose(ctx: CommandContext): string {
  if (!ctx.project) {
    throw new NoActiveSessionError();
  }

  const active = getActiveSession(ctx.project.id);
  if (!active) {
    throw new NoActiveSessionError();
  }

  if (isSessionLocked(active.id)) {
    throw new JobCollisionError(0);
  }

  closeActiveSession(ctx.project.id);
  const shortId = active.id.replace(/^sess_/, '');

  return [
    '🔒 *Session Closed*',
    '',
    `ID: #${shortId} (*${active.name}*)`,
    `Total turns: ${active.turn_count}`,
  ].join('\n');
}

export function handleSessionRename(ctx: CommandContext, newName?: string): string {
  if (!newName) {
    throw new InvalidArgumentError(
      'New session name required.',
      'Usage: /session rename <new_name>'
    );
  }

  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(newName)) {
    throw new InvalidArgumentError(
      'Name must be alphanumeric, dashes, or underscores (1-40 chars).',
      'Example: /session rename database-migration'
    );
  }

  if (!ctx.project) {
    throw new NoActiveSessionError();
  }

  const active = getActiveSession(ctx.project.id);
  if (!active) {
    throw new NoActiveSessionError();
  }

  renameSession(active.id, newName);

  return `🏷️ *Session Renamed*\n\`${active.id}\` is now labeled: *${newName}*`;
}
