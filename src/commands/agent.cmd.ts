import type { CommandContext } from './types.js';
import { updateSelectedAgent } from '../database/repositories/project.repo.js';
import { getActiveSession, closeActiveSession } from '../database/repositories/session.repo.js';
import {
  setSelectionCache,
  resolveSelectionIndex,
  type SelectionItem,
} from '../state/selection-cache.js';
import { InvalidArgumentError, NotFoundError } from '../router/errors.js';
import { getDatabase } from '../database/connection.js';

export const SUPPORTED_AGENTS = [
  { name: 'claude', label: 'Claude Code', binary: 'claude' },
  { name: 'antigravity', label: 'Antigravity', binary: 'agy' },
  { name: 'codex', label: 'Codex CLI', binary: 'codex' },
  { name: 'opencode', label: 'OpenCode', binary: 'opencode' },
  { name: 'copilot', label: 'GitHub Copilot', binary: 'copilot' },
];

export async function handleAgent(ctx: CommandContext): Promise<string> {
  if (!ctx.project) {
    return [
      '⚠️ *No project selected.*',
      '',
      'Select a project first:',
      '  `/project select <path>`',
    ].join('\n');
  }

  const { subcommand, args } = ctx.parsed;

  if (subcommand === 'list' || !subcommand) {
    return handleAgentList(ctx);
  }

  if (subcommand === 'select' || subcommand === 'switch') {
    return handleAgentSelect(ctx, args[0]);
  }

  // Handle direct `/agent claude` or `/agent 1`
  return handleAgentSelect(ctx, subcommand);
}

export function handleAgentList(ctx: CommandContext): string {
  const currentAgent = ctx.project?.selected_agent && ctx.project.selected_agent !== 'none'
    ? (SUPPORTED_AGENTS.find((a) => a.name === ctx.project!.selected_agent)?.label || ctx.project!.selected_agent)
    : 'None';

  const selectionItems: SelectionItem[] = [];
  const lines: string[] = ['🧠 *Select Agent*', ''];

  SUPPORTED_AGENTS.forEach((agent, idx) => {
    const index = idx + 1;
    const isActive = ctx.project?.selected_agent === agent.name;

    selectionItems.push({
      index,
      label: agent.label,
      value: agent.name,
      type: 'agent',
    });

    lines.push(
      `${index}. ${isActive ? '🟢' : '⚪'} *${agent.label}*${isActive ? ' (Active)' : ''}`
    );
  });

  lines.push('', `Current: ${currentAgent}`, '', 'Use:', '  `/agent select <1-5 | name>`');

  setSelectionCache(ctx.user.id, 'AGENT_LIST', ctx.navCwd, selectionItems);

  return lines.join('\n');
}

export function handleAgentSelect(ctx: CommandContext, target?: string): string {
  if (!ctx.project) {
    return [
      '⚠️ *No project selected.*',
      '',
      'Select a project first:',
      '  `/project select <path>`',
    ].join('\n');
  }

  if (!target) {
    throw new InvalidArgumentError(
      'Target agent name or index required.',
      'Usage: /agent select <1-5 | name>'
    );
  }

  let agentName: string;
  if (/^\d+$/.test(target)) {
    const index = parseInt(target, 10);
    const item = resolveSelectionIndex(ctx.user.id, index, undefined, 'agent');
    agentName = item.value;
  } else {
    agentName = target.toLowerCase();
  }

  const found = SUPPORTED_AGENTS.find(
    (a) => a.name === agentName || a.binary === agentName
  );

  if (!found) {
    throw new NotFoundError(
      'Agent',
      target,
      'Use /agent to view available agents.'
    );
  }

  // Changing agent: if session has not started any turns, adapt it to the new agent;
  // if it already has turns from the previous agent, close it so a fresh session can be created.
  const activeSession = getActiveSession(ctx.project.id);
  let sessionStatus = 'Not created';
  if (activeSession) {
    if (activeSession.agent_name !== found.name) {
      if (activeSession.turn_count === 0) {
        const db = getDatabase();
        db.prepare('UPDATE sessions SET agent_name = ? WHERE id = ?').run(found.name, activeSession.id);
        activeSession.agent_name = found.name;
        sessionStatus = `#${activeSession.id.replace(/^sess_/, '')} (Active)`;
      } else {
        closeActiveSession(ctx.project.id);
        sessionStatus = 'Not created (previous session ended)';
      }
    } else {
      sessionStatus = `#${activeSession.id.replace(/^sess_/, '')} (Active)`;
    }
  }

  updateSelectedAgent(ctx.project.id, found.name);
  ctx.project.selected_agent = found.name;

  return [
    '🧠 *Agent selected*',
    '',
    `*${found.label}*`,
    '',
    '📦 *Project:*',
    ctx.project.name,
    '',
    `📍 \`${ctx.project.root_path}\``,
    '',
    '💬 *Session:*',
    sessionStatus,
    '',
    'Next:',
    '  `/session create`',
  ].join('\n');
}
