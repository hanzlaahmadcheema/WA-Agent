import type { CommandContext } from './types.js';
import { updateSelectedAgent } from '../database/repositories/project.repo.js';
import {
  setSelectionCache,
  resolveSelectionIndex,
  type SelectionItem,
} from '../state/selection-cache.js';
import { InvalidArgumentError, NotFoundError } from '../router/errors.js';

export const SUPPORTED_AGENTS = [
  { name: 'claude', label: 'Claude Code', binary: 'claude' },
  { name: 'antigravity', label: 'Antigravity', binary: 'agy' },
  { name: 'codex', label: 'Codex CLI', binary: 'codex' },
  { name: 'opencode', label: 'OpenCode', binary: 'opencode' },
];

export async function handleAgent(ctx: CommandContext): Promise<string> {
  const { subcommand, args } = ctx.parsed;

  if (subcommand === 'list' || !subcommand) {
    return handleAgentList(ctx);
  }

  if (subcommand === 'select') {
    return handleAgentSelect(ctx, args[0]);
  }

  // Handle direct `/agent claude`
  return handleAgentSelect(ctx, subcommand);
}

export function handleAgentList(ctx: CommandContext): string {
  const selectionItems: SelectionItem[] = [];
  const lines: string[] = ['🤖 *Available Agents*', ''];

  SUPPORTED_AGENTS.forEach((agent, idx) => {
    const index = idx + 1;
    const isActive = ctx.project.selected_agent === agent.name;

    selectionItems.push({
      index,
      label: agent.label,
      value: agent.name,
      type: 'agent',
    });

    lines.push(
      `${index}. ${isActive ? '🟢' : '⚪'} *${agent.label}*${isActive ? ' (Active)' : ''}\n   CLI: \`${agent.binary}\``
    );
  });

  lines.push('', '_Switch using `/agent select <n>`._');

  setSelectionCache(ctx.user.id, 'AGENT_LIST', ctx.project.cwd, selectionItems);

  return lines.join('\n');
}

export function handleAgentSelect(ctx: CommandContext, target?: string): string {
  if (!target) {
    throw new InvalidArgumentError(
      'Target agent name or index required.',
      'Usage: /agent select <name | index>'
    );
  }

  let agentName: string;
  if (/^\d+$/.test(target)) {
    const index = parseInt(target, 10);
    const item = resolveSelectionIndex(ctx.user.id, index, ctx.project.cwd, 'agent');
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
      'Use /agent list to view available agents.'
    );
  }

  updateSelectedAgent(ctx.project.id, found.name);
  ctx.project.selected_agent = found.name;

  return [
    `✅ *Agent switched to ${found.label}*`,
    '',
    `Agent: ${found.label}`,
    `Directory: \`${ctx.project.cwd}\``,
  ].join('\n');
}
