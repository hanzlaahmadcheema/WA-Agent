import path from 'node:path';
import fs from 'node:fs/promises';
import { SandboxViolationError } from '../router/errors.js';

export function isContainedInRoots(targetPath: string, allowedRoots: string[]): boolean {
  const normalizedTarget = path.resolve(targetPath);
  return allowedRoots.some((root) => {
    const normalizedRoot = path.resolve(root);
    const relative = path.relative(normalizedRoot, normalizedTarget);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

export async function resolveSafePath(
  requestedPath: string,
  currentDir: string,
  allowedRoots: string[],
  projectRoot?: string
): Promise<string> {
  let resolved: string;

  // Handle tilde ~
  if (requestedPath === '~' || requestedPath.startsWith('~/')) {
    const base = projectRoot || allowedRoots[0];
    resolved = path.resolve(base, requestedPath.replace(/^~(?:\/)?/, ''));
  } else if (path.isAbsolute(requestedPath)) {
    resolved = path.resolve(requestedPath);
  } else {
    resolved = path.resolve(currentDir, requestedPath);
  }

  // Canonicalize symlinks if target exists
  let realPath: string;
  try {
    realPath = await fs.realpath(resolved);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // Check parent directory
      const parent = path.dirname(resolved);
      try {
        const realParent = await fs.realpath(parent);
        realPath = path.join(realParent, path.basename(resolved));
      } catch {
        realPath = resolved;
      }
    } else {
      realPath = resolved;
    }
  }

  if (!isContainedInRoots(realPath, allowedRoots)) {
    throw new SandboxViolationError(requestedPath);
  }

  return realPath;
}
