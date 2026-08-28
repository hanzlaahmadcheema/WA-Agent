import type { AgentDriver } from './agent-driver.interface.js';
import { ClaudeCodeDriver } from './drivers/claude-code.driver.js';
import { NotFoundError } from '../router/errors.js';

const drivers = new Map<string, AgentDriver>();

const defaultClaude = new ClaudeCodeDriver();
drivers.set(defaultClaude.name, defaultClaude);

export function registerAgentDriver(driver: AgentDriver): void {
  drivers.set(driver.name.toLowerCase(), driver);
}

export function getAgentDriver(name: string): AgentDriver {
  const driver = drivers.get(name.toLowerCase());
  if (!driver) {
    throw new NotFoundError(
      'Agent Driver',
      name,
      'Currently supported driver: claude'
    );
  }
  return driver;
}
