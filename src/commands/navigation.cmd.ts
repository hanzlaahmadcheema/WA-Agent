import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandContext } from './types.js';
import { config } from '../config.js';
import { resolveSafePath, isContainedInRoots } from '../security/sandbox.js';
import { updateProjectCwd } from '../database/repositories/project.repo.js';
import { setUserNavCwd } from '../state/user-nav.js';
import {
  setSelectionCache,
  resolveSelectionIndex,
  type SelectionItem,
} from '../state/selection-cache.js';
import {
  InvalidArgumentError,
  NotFoundError,
  SandboxViolationError,
} from '../router/errors.js';
import { checkAndRecordRateLimit } from '../security/rate-limiter.js';

export async function handleNavigation(ctx: CommandContext): Promise<string> {
  checkAndRecordRateLimit(ctx.user.id, 'filesystem');
  const { subcommand, args } = ctx.parsed;

  switch (subcommand) {
    case 'pwd':
      return handlePwd(ctx);
    case 'ls':
      return handleLs(ctx, args[0]);
    case 'cd':
      return handleCd(ctx, args[0]);
    case 'up':
    case 'back':
      return handleUp(ctx, args[0]);
    case 'tree':
      return handleTree(ctx, args[0]);
    default:
      throw new InvalidArgumentError(
        `Unknown navigation subcommand: "${subcommand}"`,
        'Use /pwd, /ls, /cd, /back, or /tree.'
      );
  }
}

export function handlePwd(ctx: CommandContext): string {
  return `📍 Current directory:\n${ctx.navCwd}`;
}

export async function handleLs(ctx: CommandContext, requestedPath?: string): Promise<string> {
  const targetDir = requestedPath
    ? await resolveSafePath(requestedPath, ctx.navCwd, config.ALLOWED_ROOTS)
    : ctx.navCwd;

  let stat;
  try {
    stat = await fs.stat(targetDir);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new NotFoundError('Directory', targetDir, 'Check path with /pwd or /ls.');
    }
    throw err;
  }

  if (!stat.isDirectory()) {
    throw new InvalidArgumentError(
      `"${targetDir}" is a file, not a directory.`,
      'Use /view to inspect file contents.'
    );
  }

  const entries = await fs.readdir(targetDir, { withFileTypes: true });

  // Filter out noise (.git, node_modules) unless requested
  const filtered = entries.filter((e) => !['.git', 'node_modules'].includes(e.name));

  // Sort: directories first, then files alphabetically
  filtered.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  const selectionItems: SelectionItem[] = [];
  const lines: string[] = [`📁 *${targetDir}*`, ''];

  filtered.forEach((entry, idx) => {
    const isDir = entry.isDirectory();
    const index = idx + 1;
    const label = isDir ? `${entry.name}/` : entry.name;
    const fullPath = path.join(targetDir, entry.name);

    selectionItems.push({
      index,
      label,
      value: fullPath,
      type: isDir ? 'dir' : 'file',
    });

    lines.push(`${index}. ${isDir ? '📁' : '📄'} ${label}`);
  });

  if (selectionItems.length === 0) {
    lines.push('_Directory is empty._');
  } else {
    lines.push('', '_Use `/cd <n|name>` to enter a folder or `/view <n|name>` to inspect a file._');
  }

  // Update ephemeral selection cache
  setSelectionCache(ctx.user.id, 'NAVIGATION_LS', ctx.navCwd, selectionItems);

  return lines.join('\n');
}

export async function handleCd(ctx: CommandContext, target?: string): Promise<string> {
  if (!target) {
    throw new InvalidArgumentError(
      'Target path or index required.',
      'Usage: /cd <path | index> (e.g. /cd src or /cd 2)'
    );
  }

  // Handle cd .. or /cd /back
  if (target === '..' || target === '../') {
    return handleUp(ctx, '1');
  }

  let resolvedDir: string;

  // Numeric selection against latest listing
  if (/^\d+$/.test(target)) {
    const index = parseInt(target, 10);
    const item = resolveSelectionIndex(ctx.user.id, index, ctx.navCwd, 'dir');
    resolvedDir = item.value;
  } else {
    resolvedDir = await resolveSafePath(
      target,
      ctx.navCwd,
      config.ALLOWED_ROOTS
    );
  }

  const stat = await fs.stat(resolvedDir).catch(() => null);
  if (!stat) {
    throw new NotFoundError('Directory', resolvedDir);
  }
  if (!stat.isDirectory()) {
    throw new InvalidArgumentError(
      `"${resolvedDir}" is not a directory.`,
      'Use /view, /head, or /tail to inspect files.'
    );
  }

  // Update navigation CWD
  setUserNavCwd(ctx.user.id, resolvedDir);
  ctx.navCwd = resolvedDir;

  if (ctx.project) {
    updateProjectCwd(ctx.project.id, resolvedDir);
    ctx.project.cwd = resolvedDir;
  }

  return `📍 Current directory:\n${resolvedDir}`;
}

export async function handleUp(ctx: CommandContext, levelsStr?: string): Promise<string> {
  const levels = levelsStr ? parseInt(levelsStr, 10) : 1;
  if (isNaN(levels) || levels < 1) {
    throw new InvalidArgumentError(
      'Levels must be a positive integer.',
      'Usage: /back or /up [levels]'
    );
  }

  let target = ctx.navCwd;
  for (let i = 0; i < levels; i++) {
    const parent = path.dirname(target);
    if (!isContainedInRoots(parent, config.ALLOWED_ROOTS)) {
      throw new SandboxViolationError(parent);
    }
    target = parent;
  }

  setUserNavCwd(ctx.user.id, target);
  ctx.navCwd = target;

  if (ctx.project) {
    updateProjectCwd(ctx.project.id, target);
    ctx.project.cwd = target;
  }

  return `📍 Current directory:\n${target}`;
}

export async function handleTree(ctx: CommandContext, depthStr?: string): Promise<string> {
  const depth = depthStr ? parseInt(depthStr, 10) : 2;
  if (isNaN(depth) || depth < 1 || depth > 4) {
    throw new InvalidArgumentError(
      'Depth must be between 1 and 4.',
      'Usage: /tree [1-4]'
    );
  }

  const lines: string[] = [`🌳 *Tree: ${path.basename(ctx.navCwd)} (depth: ${depth})*`, ''];
  let totalEntries = 0;
  const MAX_ENTRIES = 100;

  async function buildTree(dir: string, currentDepth: number, prefix: string) {
    if (currentDepth > depth || totalEntries >= MAX_ENTRIES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const filtered = entries.filter((e) => !['.git', 'node_modules', 'dist', '.next'].includes(e.name));

    for (let i = 0; i < filtered.length; i++) {
      if (totalEntries >= MAX_ENTRIES) {
        lines.push(`${prefix}... [capped at ${MAX_ENTRIES} entries]`);
        return;
      }
      const entry = filtered[i];
      const isLast = i === filtered.length - 1;
      const pointer = isLast ? '└── ' : '├── ';
      lines.push(`${prefix}${pointer}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      totalEntries++;

      if (entry.isDirectory()) {
        const nextPrefix = prefix + (isLast ? '    ' : '│   ');
        await buildTree(path.join(dir, entry.name), currentDepth + 1, nextPrefix);
      }
    }
  }

  await buildTree(ctx.navCwd, 1, '');
  return lines.join('\n');
}
