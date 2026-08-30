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
  // Reject null-byte poisoning attacks
  if (requestedPath.includes('\0')) {
    throw new SandboxViolationError(requestedPath);
  }

  let resolved: string;

  // Handle tilde ~ expansion
  if (requestedPath === '~' || requestedPath.startsWith('~/')) {
    const candidateHomes = [
      process.env.DEFAULT_CWD,
      process.env.HOME,
      '/home/hanzlaahmad',
    ].filter(Boolean) as string[];

    let matchedHome: string | undefined;
    for (const h of candidateHomes) {
      try {
        const norm = path.resolve(h);
        if (isContainedInRoots(norm, allowedRoots)) {
          matchedHome = norm;
          break;
        }
      } catch {
        // ignore
      }
    }

    const base = matchedHome || projectRoot || allowedRoots[0];
    resolved = path.resolve(base, requestedPath.replace(/^~(?:\/)?/, ''));
  } else if (path.isAbsolute(requestedPath)) {
    resolved = path.resolve(requestedPath);
  } else {
    resolved = path.resolve(currentDir, requestedPath);
  }

  // Canonicalize symlinks if target exists (defends against symlink escape attacks)
  let realPath: string;
  try {
    realPath = await fs.realpath(resolved);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      // If path doesn't exist yet, check its canonical parent directory
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

  // Enforce sandbox boundary on canonical destination
  if (!isContainedInRoots(realPath, allowedRoots)) {
    throw new SandboxViolationError(requestedPath);
  }

  return realPath;
}
