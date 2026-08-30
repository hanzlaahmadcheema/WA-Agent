import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { isContainedInRoots } from '../security/sandbox.js';

const userNavState = new Map<string, string>();
let stateFilePath: string | null = null;

function getStateFilePath(): string {
  if (!stateFilePath) {
    stateFilePath = path.join(path.dirname(config.DATABASE_PATH), 'user_nav.json');
  }
  return stateFilePath;
}

function loadState(): void {
  try {
    const file = getStateFilePath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [userId, cwd] of Object.entries(data)) {
        if (typeof cwd === 'string' && fs.existsSync(cwd)) {
          const real = fs.realpathSync(cwd);
          if (isContainedInRoots(real, config.ALLOWED_ROOTS)) {
            userNavState.set(userId, real);
          }
        }
      }
    }
  } catch {
    // Ignore read errors
  }
}

function saveState(): void {
  try {
    const file = getStateFilePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj: Record<string, string> = {};
    for (const [userId, cwd] of userNavState.entries()) {
      obj[userId] = cwd;
    }
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    // Ignore write errors
  }
}

// Initial load
loadState();

/**
 * Gets the current terminal navigation directory for a user.
 * Defaults to config.ALLOWED_ROOTS[0].
 */
export function getUserNavCwd(userId: string): string {
  const existing = userNavState.get(userId);
  if (existing && fs.existsSync(existing)) {
    try {
      const real = fs.realpathSync(existing);
      if (isContainedInRoots(real, config.ALLOWED_ROOTS)) {
        return real;
      }
    } catch {
      // Fallback if stat/realpath failed
    }
  }

  const defaultCwd = config.ALLOWED_ROOTS[0];
  userNavState.set(userId, defaultCwd);
  return defaultCwd;
}

/**
 * Sets the terminal navigation directory for a user and persists to disk.
 */
export function setUserNavCwd(userId: string, targetPath: string): void {
  const real = fs.realpathSync(targetPath);
  if (!isContainedInRoots(real, config.ALLOWED_ROOTS)) {
    throw new Error(`Path ${real} is outside allowed roots.`);
  }
  userNavState.set(userId, real);
  saveState();
}

/**
 * Resets user navigation state to default root.
 */
export function resetUserNav(userId: string): void {
  userNavState.delete(userId);
  saveState();
}
