import type { AgentDriver } from './agent-driver.interface.js';
import { ClaudeCodeDriver } from './drivers/claude-code.driver.js';
import { AntigravityDriver } from './drivers/antigravity.driver.js';
import { NotFoundError } from '../router/errors.js';

const drivers = new Map<string, AgentDriver>();

const defaultClaude = new ClaudeCodeDriver();
drivers.set(defaultClaude.name, defaultClaude);

const defaultAntigravity = new AntigravityDriver();
drivers.set(defaultAntigravity.name, defaultAntigravity);
drivers.set('agy', defaultAntigravity);

export function registerAgentDriver(driver: AgentDriver): void {
  drivers.set(driver.name.toLowerCase(), driver);
}

export function getAgentDriver(name: string): AgentDriver {
  const driver = drivers.get(name.toLowerCase());
  if (!driver) {
    throw new NotFoundError(
      'Agent Driver',
      name,
      'Currently supported drivers: claude, antigravity (agy)'
    );
  }
  return driver;
}
