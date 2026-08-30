import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const cliActiveMap = new Map<string, boolean>();
let stateFilePath: string | null = null;

function getStateFilePath(): string {
  if (!stateFilePath) {
    stateFilePath = path.join(path.dirname(config.DATABASE_PATH), 'cli_state.json');
  }
  return stateFilePath;
}

function loadState(): void {
  try {
    const file = getStateFilePath();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [userId, active] of Object.entries(data)) {
        if (typeof active === 'boolean') {
          cliActiveMap.set(userId, active);
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
    const obj: Record<string, boolean> = {};
    for (const [userId, active] of cliActiveMap.entries()) {
      obj[userId] = active;
    }
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    // Ignore write errors
  }
}

// Initial load
loadState();

let defaultActiveForTests =
  process.env.NODE_ENV === 'test' ||
  Boolean(process.env.NODE_TEST_CONTEXT) ||
  process.argv.some((arg) => arg.includes('test'));

export function setDefaultActiveForTests(val: boolean): void {
  defaultActiveForTests = val;
}

/**
 * Checks if the WhatsApp CLI terminal session is active for a given user.
 * Defaults to false (requires explicit /start).
 */
export function isCliActive(userId: string): boolean {
  if (cliActiveMap.has(userId)) {
    return cliActiveMap.get(userId) === true;
  }
  return defaultActiveForTests;
}

/**
 * Marks the CLI terminal session as active for a user.
 */
export function startCliSession(userId: string): void {
  cliActiveMap.set(userId, true);
  saveState();
}

/**
 * Marks the CLI terminal session as stopped for a user.
 */
export function stopCliSession(userId: string): void {
  cliActiveMap.set(userId, false);
  saveState();
}

/**
 * Resets CLI session state for testing.
 */
export function resetCliSession(userId: string): void {
  cliActiveMap.delete(userId);
  saveState();
}
