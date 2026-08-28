import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandContext } from './types.js';
import { config } from '../config.js';
import { resolveSafePath } from '../security/sandbox.js';
import { resolveSelectionIndex } from '../state/selection-cache.js';
import {
  InvalidArgumentError,
  NotFoundError,
} from '../router/errors.js';

export async function handleFiles(ctx: CommandContext): Promise<string> {
  const { subcommand, args } = ctx.parsed;

  switch (subcommand) {
    case 'view':
      return handleView(ctx, args[0], args[1]);
    case 'head':
      return handleHead(ctx, args[0], args[1]);
    case 'tail':
      return handleTail(ctx, args[0], args[1]);
    case 'grep':
      return handleGrep(ctx, args[0], args[1]);
    default:
      throw new InvalidArgumentError(
        `Unknown files subcommand: "${subcommand}"`,
        'Use /view, /head, /tail, or /grep.'
      );
  }
}

async function resolveTargetFile(
  ctx: CommandContext,
  target?: string
): Promise<string> {
  if (!target) {
    throw new InvalidArgumentError(
      'Target file or index required.',
      'Usage: /view <file | index>'
    );
  }

  let filePath: string;
  if (/^\d+$/.test(target)) {
    const index = parseInt(target, 10);
    const item = resolveSelectionIndex(ctx.user.id, index, ctx.project.cwd, 'file');
    filePath = item.value;
  } else {
    filePath = await resolveSafePath(
      target,
      ctx.project.cwd,
      config.ALLOWED_ROOTS,
      ctx.project.root_path
    );
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    throw new NotFoundError('File', filePath);
  }
  if (!stat.isFile()) {
    throw new InvalidArgumentError(
      `"${filePath}" is a directory.`,
      'Use /cd to enter directories.'
    );
  }
  if (stat.size > 10 * 1024 * 1024) {
    throw new InvalidArgumentError(
      'File exceeds size limit (10MB).',
      'Choose a smaller file or inspect specific sections.'
    );
  }

  return filePath;
}

export async function handleView(
  ctx: CommandContext,
  target?: string,
  pageStr?: string
): Promise<string> {
  const filePath = await resolveTargetFile(ctx, target);
  const page = pageStr ? parseInt(pageStr, 10) : 1;
  if (isNaN(page) || page < 1) {
    throw new InvalidArgumentError('Page must be a positive integer.', 'Usage: /view <file> [page]');
  }

  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const PAGE_SIZE = 50;
  const totalPages = Math.max(1, Math.ceil(lines.length / PAGE_SIZE));

  if (page > totalPages) {
    throw new InvalidArgumentError(
      `Page ${page} is out of range.`,
      `Total pages: ${totalPages}.`
    );
  }

  const startLine = (page - 1) * PAGE_SIZE;
  const endLine = Math.min(lines.length, startLine + PAGE_SIZE);
  const pageLines = lines.slice(startLine, endLine);

  const displayLines = pageLines.map((line, idx) => {
    const lineNum = startLine + idx + 1;
    return `${lineNum} | ${line}`;
  });

  const relativeName = path.relative(ctx.project.cwd, filePath) || path.basename(filePath);
  const ext = path.extname(filePath).slice(1) || 'txt';

  const output: string[] = [
    `📄 *${relativeName}* (Page ${page}/${totalPages} • Lines ${startLine + 1}–${endLine} of ${lines.length})`,
    `\`\`\`${ext}`,
    ...displayLines,
    '```',
  ];

  if (page < totalPages) {
    output.push(`_Use \`/view ${target} ${page + 1}\` to view next page._`);
  }

  return output.join('\n');
}

export async function handleHead(
  ctx: CommandContext,
  target?: string,
  linesStr?: string
): Promise<string> {
  const filePath = await resolveTargetFile(ctx, target);
  const count = linesStr ? parseInt(linesStr, 10) : 20;
  if (isNaN(count) || count < 1 || count > 60) {
    throw new InvalidArgumentError(
      'Line count must be between 1 and 60.',
      'Usage: /head <file> 20'
    );
  }

  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split('\n').slice(0, count);
  const relativeName = path.relative(ctx.project.cwd, filePath) || path.basename(filePath);
  const ext = path.extname(filePath).slice(1) || 'txt';

  return [
    `📄 *Head: ${relativeName} (First ${lines.length} lines)*`,
    `\`\`\`${ext}`,
    ...lines,
    '```',
  ].join('\n');
}

export async function handleTail(
  ctx: CommandContext,
  target?: string,
  linesStr?: string
): Promise<string> {
  const filePath = await resolveTargetFile(ctx, target);
  const count = linesStr ? parseInt(linesStr, 10) : 20;
  if (isNaN(count) || count < 1 || count > 60) {
    throw new InvalidArgumentError(
      'Line count must be between 1 and 60.',
      'Usage: /tail <file> 20'
    );
  }

  const content = await fs.readFile(filePath, 'utf8');
  const allLines = content.split('\n');
  const lines = allLines.slice(Math.max(0, allLines.length - count));
  const relativeName = path.relative(ctx.project.cwd, filePath) || path.basename(filePath);
  const ext = path.extname(filePath).slice(1) || 'txt';

  return [
    `📄 *Tail: ${relativeName} (Last ${lines.length} lines)*`,
    `\`\`\`${ext}`,
    ...lines,
    '```',
  ].join('\n');
}

export async function handleGrep(
  ctx: CommandContext,
  pattern?: string,
  subPath?: string
): Promise<string> {
  if (!pattern) {
    throw new InvalidArgumentError(
      'Pattern is required.',
      'Usage: /grep "<pattern>" [path]'
    );
  }

  const searchDir = subPath
    ? await resolveSafePath(subPath, ctx.project.cwd, config.ALLOWED_ROOTS, ctx.project.root_path)
    : ctx.project.cwd;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'i');
  } catch (err: any) {
    throw new InvalidArgumentError(`Invalid regex pattern: ${err.message}`, 'Check pattern syntax.');
  }

  const MAX_MATCHES = 15;
  const matches: Array<{ file: string; line: number; text: string }> = [];

  async function walk(dir: string) {
    if (matches.length >= MAX_MATCHES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) break;
      if (['.git', 'node_modules', 'dist', '.next'].includes(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > 2 * 1024 * 1024) continue; // Skip files > 2MB for grep
          const text = await fs.readFile(fullPath, 'utf8');
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              matches.push({
                file: path.relative(ctx.project.cwd, fullPath),
                line: i + 1,
                text: lines[i].trim().slice(0, 100),
              });
              if (matches.length >= MAX_MATCHES) break;
            }
          }
        } catch {
          // ignore unreadable/binary
        }
      }
    }
  }

  await walk(searchDir);

  if (matches.length === 0) {
    return `🔍 Grep: No matches found for \`"${pattern}"\` in \`${path.basename(searchDir)}\`.`;
  }

  const output: string[] = [
    `🔍 *Grep: "${pattern}" in ${path.basename(searchDir)}*`,
    '',
  ];

  matches.forEach((m, idx) => {
    output.push(`${idx + 1}. \`${m.file}:${m.line}\`\n   > ${m.text}`);
  });

  output.push('', `_Found ${matches.length} matches${matches.length >= MAX_MATCHES ? ' (capped at 15)' : ''}._`);
  return output.join('\n');
}
