import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandContext } from './types.js';
import { config } from '../config.js';
import { resolveSafePath } from '../security/sandbox.js';
import {
  getUserProjects,
  getActiveProject,
  setActiveProject,
  getOrCreateProject,
} from '../database/repositories/project.repo.js';
import { getActiveSession } from '../database/repositories/session.repo.js';
import { SUPPORTED_AGENTS } from './agent.cmd.js';
import {
  setSelectionCache,
  resolveSelectionIndex,
  type SelectionItem,
} from '../state/selection-cache.js';
import { InvalidArgumentError, NotFoundError } from '../router/errors.js';
import { getDatabase } from '../database/connection.js';

export async function handleProject(ctx: CommandContext): Promise<string> {
  const { subcommand, args } = ctx.parsed;

  switch (subcommand) {
    case 'select':
      return await handleProjectSelect(ctx, args[0]);
    case 'list':
      return handleProjectList(ctx);
    case 'deselect':
      return handleProjectDeselect(ctx);
    default:
      if (subcommand && !['show', 'info'].includes(subcommand)) {
        // Direct `/project WA-Agent`
        return await handleProjectSelect(ctx, subcommand);
      }
      return handleProjectShow(ctx);
  }
}

export function handleProjectShow(ctx: CommandContext): string {
  const active = ctx.project || getActiveProject(ctx.user.id);
  if (!active) {
    return [
      '📁 *Project: Not selected*',
      '',
      'Use:',
      '  `/project select <path|name>`',
      '  `/project list`',
    ].join('\n');
  }

  const activeSession = getActiveSession(active.id);
  const agentMeta = SUPPORTED_AGENTS.find((a) => a.name === active.selected_agent);
  const agentDisplay = active.selected_agent && active.selected_agent !== 'none'
    ? (agentMeta?.label || active.selected_agent)
    : 'Not selected';
  const sessionDisplay = activeSession
    ? `#${activeSession.id.replace(/^sess_/, '')}`
    : 'Not created';

  return [
    '📦 *Active Project*',
    '',
    `Name: *${active.name}*`,
    `📍 \`${active.root_path}\``,
    '',
    `Agent:   ${agentDisplay}`,
    `Session: ${sessionDisplay}`,
    '',
    'Commands:',
    '  `/project select <path|name>`',
    '  `/project list`',
    '  `/project deselect`',
  ].join('\n');
}

export async function handleProjectSelect(
  ctx: CommandContext,
  target?: string
): Promise<string> {
  let selectedProjectId: string | null = null;
  let resolvedPath: string;

  if (target) {
    // 1. Check numeric index against PROJECT_LIST selection cache
    if (/^\d+$/.test(target)) {
      const index = parseInt(target, 10);
      try {
        const item = resolveSelectionIndex(ctx.user.id, index, undefined);
        if (item) {
          selectedProjectId = item.value;
        }
      } catch {
        // Fall back to path resolution
      }
    }

    // 2. Check if target matches existing project name (case-insensitive)
    if (!selectedProjectId) {
      const existingProjects = getUserProjects(ctx.user.id);
      const match = existingProjects.find(
        (p) => p.name.toLowerCase() === target.toLowerCase()
      );
      if (match) {
        selectedProjectId = match.id;
      }
    }

    // 3. Resolve target as directory path
    if (!selectedProjectId) {
      resolvedPath = await resolveSafePath(
        target,
        ctx.navCwd,
        config.ALLOWED_ROOTS
      );

      const stat = await fs.stat(resolvedPath).catch(() => null);
      if (!stat) {
        throw new NotFoundError('Directory', resolvedPath, 'Provide a valid project directory or name.');
      }
      if (!stat.isDirectory()) {
        throw new InvalidArgumentError(
          `"${resolvedPath}" is a file, not a directory.`,
          'A project must be a root directory.'
        );
      }

      const proj = getOrCreateProject(ctx.user.id, resolvedPath, path.basename(resolvedPath), 'none');
      selectedProjectId = proj.id;
    }
  } else {
    // If no target given, select current navigation directory
    resolvedPath = ctx.navCwd;
    const proj = getOrCreateProject(ctx.user.id, resolvedPath, path.basename(resolvedPath), 'none');
    selectedProjectId = proj.id;
  }

  const project = setActiveProject(ctx.user.id, selectedProjectId!);
  ctx.project = project;

  const activeSession = getActiveSession(project.id);
  const agentMeta = SUPPORTED_AGENTS.find((a) => a.name === project.selected_agent);
  const agentDisplay = project.selected_agent && project.selected_agent !== 'none'
    ? (agentMeta?.label || project.selected_agent)
    : 'Not selected';
  const sessionDisplay = activeSession
    ? `#${activeSession.id.replace(/^sess_/, '')}`
    : 'Not created';

  return [
    '📦 *Project selected*',
    '',
    `*${project.name}*`,
    `📍 \`${project.root_path}\``,
    '',
    `Agent:   ${agentDisplay}`,
    `Session: ${sessionDisplay}`,
    '',
    'Next:',
    '  `/agent`',
    '  `/session create`',
  ].join('\n');
}

export function handleProjectList(ctx: CommandContext): string {
  const projects = getUserProjects(ctx.user.id);
  if (projects.length === 0) {
    return [
      'ℹ️ *No projects found.*',
      '',
      'Select a directory as your project with:',
      '  `/project select <path>`',
    ].join('\n');
  }

  const selectionItems: SelectionItem[] = [];
  const lines: string[] = ['📦 *Your Projects*', ''];

  projects.forEach((p, idx) => {
    const index = idx + 1;
    const isActive = p.is_active === 1;

    selectionItems.push({
      index,
      label: p.name,
      value: p.id,
      type: 'dir',
    });

    const agentMeta = SUPPORTED_AGENTS.find((a) => a.name === p.selected_agent);
    const agentStr = p.selected_agent && p.selected_agent !== 'none'
      ? (agentMeta?.label || p.selected_agent)
      : 'No agent';

    lines.push(
      `${index}. ${isActive ? '🟢' : '⚪'} *${p.name}*${isActive ? ' (Active)' : ''}\n   📍 \`${p.root_path}\` | Agent: ${agentStr}`
    );
  });

  lines.push('', '_Select using `/project select <n|name>`._');
  setSelectionCache(ctx.user.id, 'NAVIGATION_LS', ctx.navCwd, selectionItems);

  return lines.join('\n');
}

export function handleProjectDeselect(ctx: CommandContext): string {
  const db = getDatabase();
  db.prepare('UPDATE projects SET is_active = 0 WHERE user_id = ?').run(ctx.user.id);
  ctx.project = null;
  return 'ℹ️ Project deselected.\nUse `/project select <path>` to choose an active project.';
}
