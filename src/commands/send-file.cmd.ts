import fs from 'node:fs';
import path from 'node:path';
import type { CommandContext } from './types.js';
import { InvalidArgumentError, NotFoundError } from '../router/errors.js';
import { resolveSafePath } from '../security/sandbox.js';
import { resolveSelectionIndex } from '../state/selection-cache.js';
import { config } from '../config.js';

export interface MediaPayload {
  image?: Buffer;
  document?: Buffer;
  fileName?: string;
  mimetype?: string;
  caption?: string;
}

export interface FileSendResult {
  text: string;
  media?: MediaPayload;
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.py': 'text/plain',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.html': 'text/html',
};

export async function handleSendFile(ctx: CommandContext): Promise<FileSendResult> {
  const currentDir = ctx.navCwd || ctx.project?.cwd || config.ALLOWED_ROOTS[0];
  const target = ctx.parsed.args[0] || (ctx.parsed.subcommand !== 'file' ? ctx.parsed.subcommand : undefined);

  if (!target) {
    throw new InvalidArgumentError(
      'File name or index is required.',
      'Usage: `/send <file | index>` (e.g. `/send chart.png` or `/send 3`)'
    );
  }

  let filePath: string;
  if (/^\d+$/.test(target)) {
    const index = parseInt(target, 10);
    const item = resolveSelectionIndex(ctx.user.id, index, currentDir, 'file');
    filePath = item.value;
  } else {
    filePath = await resolveSafePath(target, currentDir, config.ALLOWED_ROOTS);
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new NotFoundError('File', target, 'Check file name with `/ls` before sending.');
  }

  const stat = fs.statSync(filePath);
  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB WhatsApp limit
  if (stat.size > MAX_FILE_SIZE) {
    throw new InvalidArgumentError(
      `File is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB).`,
      'WhatsApp supports sending files up to 25MB.'
    );
  }

  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  const mimetype = MIME_MAP[ext] || 'application/octet-stream';
  const buffer = fs.readFileSync(filePath);

  const isImage = mimetype.startsWith('image/') && ext !== '.gif';

  if (isImage) {
    return {
      text: `🖼️ *Sending image*: \`${fileName}\` (${(stat.size / 1024).toFixed(1)} KB)`,
      media: {
        image: buffer,
        caption: `📄 ${fileName}`,
      },
    };
  }

  return {
    text: `📎 *Sending file*: \`${fileName}\` (${(stat.size / 1024).toFixed(1)} KB)`,
    media: {
      document: buffer,
      fileName,
      mimetype,
      caption: `📄 ${fileName}`,
    },
  };
}
