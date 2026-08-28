import type { CommandContext } from './types.js';

export function handleMenu(ctx: CommandContext): string {
  return [
    '🎮 *Claude Automation Control Plane*',
    '',
    '1. 🧭 *Navigation* (`/pwd`, `/ls`, `/cd`, `/up`, `/tree`)',
    '2. 📄 *Files* (`/view`, `/head`, `/tail`, `/grep`)',
    '3. 🤖 *Agents* (`/agent list`, `/agent select`)',
    '4. 📦 *Sessions* (`/session new`, `/session list`, `/session resume`)',
    '5. ⚙️ *Configuration* (`/config`, `/model`, `/turns`, `/render`)',
    '6. 🚀 *Tasks* (`/run`, `/jobs`, `/cancel`)',
    '7. 📊 *System* (`/status`, `/help`)',
    '',
    '_Reply with a command or number._',
  ].join('\n');
}
