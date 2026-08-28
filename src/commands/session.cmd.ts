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

export async function handleSession(ctx: CommandContext): Promise<string> {
  const { subcommand, args } = ctx.parsed;

  switch (subcommand) {
    case 'new':
      return handleSessionNew(ctx, args[0]);
    case 'list':
      return handleSessionList(ctx);
    case 'resume':
      return handleSessionResume(ctx, args[0]);
    case 'close':
      return handleSessionClose(ctx);
    case 'rename':
      return handleSessionRename(ctx, args[0]);
    default:
      // If user typed `/session`, show active session or list
      return handleSessionList(ctx);
  }
}

export function handleSessionNew(ctx: CommandContext, name?: string): string {
  const sessionName =
    name || `sess-${Math.random().toString(36).substring(2, 8)}`;

  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(sessionName)) {
    throw new InvalidArgumentError(
      'Session name must be alphanumeric, dashes, or underscores (1-40 chars).',
      'Example: /session new backend-refactor'
    );
  }

  const existing = getSessionByName(ctx.project.id, sessionName);
  if (existing) {
    throw new InvalidArgumentError(
      `Session "${sessionName}" already exists in this project.`,
      `Resume it with /session resume ${sessionName} or choose a different name.`
    );
  }

  const session = createSession(
    ctx.project.id,
    ctx.user.id,
    sessionName,
    ctx.project.selected_agent,
    ctx.project.cwd
  );

  return [
    '✨ *New Session Created*',
    '',
    `ID: \`${session.id}\``,
    `Name: *${session.name}*`,
    `Agent: ${session.agent_name}`,
    `Directory: \`${session.working_dir}\``,
    `Status: ACTIVE`,
    '',
    '_Ready for prompts. Run `/run <instruction>`._',
  ].join('\n');
}

export function handleSessionList(ctx: CommandContext): string {
  const sessions = getProjectSessions(ctx.project.id);
  if (sessions.length === 0) {
    return `ℹ️ No sessions found for this project.\n👉 Create one with \`/session new [name]\`.`;
  }

  const selectionItems: SelectionItem[] = [];
  const lines: string[] = [`📦 *Sessions for ${ctx.project.name}*`, ''];

  sessions.forEach((s, idx) => {
    const index = idx + 1;
    const isActive = s.status === 'ACTIVE';

    selectionItems.push({
      index,
      label: s.name,
      value: s.id,
      type: 'session',
    });

    const activeAgo = Math.round((Date.now() - s.last_active_at) / 60000);
    const timeStr = activeAgo <= 1 ? 'just now' : `${activeAgo}m ago`;
    const costStr = s.total_cost_usd !== null ? `$${s.total_cost_usd.toFixed(2)}` : 'N/A';

    lines.push(
      `${index}. ${isActive ? '🟢' : '⚪'} \`${s.id}\` | *${s.name}* (${s.status})\n   Turns: ${s.turn_count} | Cost: ${costStr} | Active: ${timeStr}`
    );
  });

  lines.push('', '_Resume with `/session resume <n>`._');

  setSelectionCache(ctx.user.id, 'SESSION_LIST', ctx.project.cwd, selectionItems);

  return lines.join('\n');
}

export function handleSessionResume(ctx: CommandContext, target?: string): string {
  if (!target) {
    throw new InvalidArgumentError(
      'Target session ID, name, or index required.',
      'Usage: /session resume <id | index | name>'
    );
  }

  let sessionToResume;
  if (/^\d+$/.test(target)) {
    const index = parseInt(target, 10);
    const item = resolveSelectionIndex(ctx.user.id, index, ctx.project.cwd, 'session');
    sessionToResume = getSessionById(item.value);
  } else {
    sessionToResume =
      getSessionById(target) || getSessionByName(ctx.project.id, target);
  }

  if (!sessionToResume || sessionToResume.user_id !== ctx.user.id) {
    throw new NotFoundError(
      'Session',
      target,
      'Check existing sessions with /session list.'
    );
  }

  const resumed = resumeSession(ctx.project.id, sessionToResume.id);
  const costStr = resumed.total_cost_usd !== null ? `$${resumed.total_cost_usd.toFixed(2)}` : 'N/A';

  return [
    '🔄 *Session Resumed*',
    '',
    `ID: \`${resumed.id}\` (*${resumed.name}*)`,
    `Agent: ${resumed.agent_name}`,
    `Turns: ${resumed.turn_count} | Total Cost: ${costStr}`,
  ].join('\n');
}

export function handleSessionClose(ctx: CommandContext): string {
  const active = getActiveSession(ctx.project.id);
  if (!active) {
    throw new NoActiveSessionError();
  }

  if (isSessionLocked(active.id)) {
    throw new JobCollisionError(0);
  }

  closeActiveSession(ctx.project.id);
  const costStr = active.total_cost_usd !== null ? `$${active.total_cost_usd.toFixed(2)}` : 'N/A';

  return [
    '🔒 *Session Closed*',
    '',
    `ID: \`${active.id}\` (*${active.name}*)`,
    `Total turns: ${active.turn_count}`,
    `Total Cost: ${costStr}`,
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

  const active = getActiveSession(ctx.project.id);
  if (!active) {
    throw new NoActiveSessionError();
  }

  renameSession(active.id, newName);

  return `🏷️ *Session Renamed*\n\`${active.id}\` is now labeled: *${newName}*`;
}
