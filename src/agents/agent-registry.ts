import type { AgentDriver } from './agent-driver.interface.js';
import { ClaudeCodeDriver } from './drivers/claude-code.driver.js';
import { AntigravityDriver } from './drivers/antigravity.driver.js';
import { CodexDriver } from './drivers/codex.driver.js';
import { OpenCodeDriver } from './drivers/opencode.driver.js';
import { CopilotDriver } from './drivers/copilot.driver.js';
import { NotFoundError } from '../router/errors.js';

const drivers = new Map<string, AgentDriver>();

const defaultClaude = new ClaudeCodeDriver();
drivers.set(defaultClaude.name, defaultClaude);

const defaultAntigravity = new AntigravityDriver();
drivers.set(defaultAntigravity.name, defaultAntigravity);
drivers.set('agy', defaultAntigravity);

const defaultCodex = new CodexDriver();
drivers.set(defaultCodex.name, defaultCodex);

const defaultOpenCode = new OpenCodeDriver();
drivers.set(defaultOpenCode.name, defaultOpenCode);

const defaultCopilot = new CopilotDriver();
drivers.set(defaultCopilot.name, defaultCopilot);

export function registerAgentDriver(driver: AgentDriver): void {
  drivers.set(driver.name.toLowerCase(), driver);
}

export function getAgentDriver(name: string): AgentDriver {
  const driver = drivers.get(name.toLowerCase());
  if (!driver) {
    throw new NotFoundError(
      'Agent Driver',
      name,
      'Currently supported drivers: claude, antigravity (agy), codex, opencode, copilot'
    );
  }
  return driver;
}
