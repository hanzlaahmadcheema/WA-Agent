import type { CommandContext } from './types.js';
import { getActiveSession } from '../database/repositories/session.repo.js';
import { SUPPORTED_AGENTS } from './agent.cmd.js';

export function handleMenu(ctx: CommandContext): string {
  const dirDisplay = ctx.navCwd;
  const projDisplay = ctx.project ? ctx.project.name : 'Not selected';

  let agentDisplay = 'Not selected';
  if (ctx.project?.selected_agent && ctx.project.selected_agent !== 'none') {
    const meta = SUPPORTED_AGENTS.find((a) => a.name === ctx.project!.selected_agent);
    agentDisplay = meta?.label || ctx.project.selected_agent;
  }

  let sessionDisplay = 'Not created';
  if (ctx.project) {
    const activeSession = getActiveSession(ctx.project.id);
    if (activeSession) {
      sessionDisplay = `#${activeSession.id.replace(/^sess_/, '')}`;
    }
  }

  const isReady =
    ctx.project &&
    ctx.project.selected_agent &&
    ctx.project.selected_agent !== 'none' &&
    sessionDisplay !== 'Not created';

  return [
    '🤖 *WA-Agent* (Claude Automation Control Plane)',
    '',
    '📍 *Directory*',
    `  ${dirDisplay}`,
    '',
    '📁 *Project*',
    `  ${projDisplay}`,
    '',
    '🧠 *Agent*',
    `  ${agentDisplay}`,
    '',
    '💬 *Session*',
    `  ${sessionDisplay}`,
    '',
    '━━━━━━━━━━━━━━━━━━',
    `*STATUS*: ${isReady ? '🟢 Ready' : '🟡 Setup required'}`,
    '━━━━━━━━━━━━━━━━━━',
    '*Navigation*',
    '  `/cd <path>`',
    '  `/pwd`',
    '  `/ls [path]`',
    '  `/back`',
    '',
    '*Project*',
    '  `/project`',
    '  `/project select <path>`',
    '',
    '*AI*',
    '  `/agent`',
    '  `/session`',
    '  `/run <prompt>`',
    '',
    '*System*',
    '  `/status`',
    '  `/help`',
    '  `/menu`',
  ].join('\n');
}
