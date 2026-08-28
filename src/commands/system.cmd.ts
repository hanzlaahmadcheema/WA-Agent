import type { CommandContext } from './types.js';
import { getActiveSession } from '../database/repositories/session.repo.js';
import { getActiveJobForSession } from '../state/session-lock.js';
import { config } from '../config.js';

export async function handleSystem(ctx: CommandContext): Promise<string> {
  const { subcommand, args } = ctx.parsed;

  if (subcommand === 'status' || !subcommand) {
    return handleStatus(ctx);
  }

  if (subcommand === 'help') {
    return handleHelp(ctx, args[0]);
  }

  return handleStatus(ctx);
}

export function handleStatus(ctx: CommandContext): string {
  const activeSession = getActiveSession(ctx.project.id);
  const activeJobId = activeSession ? getActiveJobForSession(activeSession.id) : undefined;
  const sessionStatus = activeSession
    ? activeJobId !== undefined
      ? `RUNNING (Job #${activeJobId})`
      : 'IDLE (Ready)'
    : 'None';

  const uptimeSec = Math.floor(process.uptime());
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);

  return [
    '📊 *System Status*',
    '',
    `• *Project*: ${ctx.project.name} (\`${ctx.project.cwd}\`)`,
    `• *Active Agent*: ${ctx.project.selected_agent}`,
    `• *Active Session*: ${activeSession ? `\`${activeSession.id}\` (*${activeSession.name}*)` : 'None'}`,
    `• *Session State*: ${sessionStatus}`,
    `• *Sandbox*: Enforced (${config.ALLOWED_ROOTS.length} root${config.ALLOWED_ROOTS.length > 1 ? 's' : ''})`,
    `• *Daemon Uptime*: ${hours}h ${mins}m`,
  ].join('\n');
}

export function handleHelp(ctx: CommandContext, specificCmd?: string): string {
  if (specificCmd) {
    const cmd = specificCmd.toLowerCase().replace(/^\//, '');
    const helpDocs: Record<string, string> = {
      pwd: '📁 */pwd*\nPrints the current working directory inside the sandbox.',
      ls: '📁 */ls [path]*\nLists files and folders with numeric indices for quick navigation.',
      cd: '📁 */cd <path | index>*\nChanges directory using a path or numeric index from the latest /ls.',
      up: '📁 */up [levels]*\nMoves up one or more parent directory levels within the sandbox boundary.',
      tree: '🌳 */tree [depth]*\nDisplays directory tree hierarchy (depth 1 to 4).',
      view: '📄 */view <file | index> [page]*\nInspects file contents (50 lines per page).',
      head: '📄 */head <file | index> [lines]*\nDisplays first N lines of a file (default 20, max 60).',
      tail: '📄 */tail <file | index> [lines]*\nDisplays last N lines of a file (default 20, max 60).',
      grep: '🔍 */grep "<pattern>" [path]*\nSearches text pattern or regex across files.',
      run: '🚀 */run <instruction>*\nExecutes an agent task asynchronously in background. Returns immediately with Job ID.',
      jobs: '📋 */jobs*\nLists active and recently executed background tasks.',
      job: '📊 */job <id> [full]*\nDisplays task results, stats, or raw stdout excerpt.',
      cancel: '🛑 */cancel <id>*\nSends SIGTERM (then SIGKILL) to terminate running task and all child processes.',
      session: '📦 */session <new | list | resume | close | rename>*\nManages task execution conversations.',
      config: '⚙️ */config*\nDisplays or modifies model, turns, budget, permission mode, or render format.',
    };

    if (helpDocs[cmd]) {
      return helpDocs[cmd];
    }
  }

  return [
    '📖 *WhatsApp Control Plane Help*',
    '',
    '*Navigation*:',
    '• `/pwd`, `/ls`, `/cd <path|n>`, `/up`, `/tree`',
    '',
    '*Files*:',
    '• `/view <file|n> [page]`, `/head <file|n>`, `/tail <file|n>`, `/grep "<pat>"`',
    '',
    '*Sessions & Agents*:',
    '• `/session new [name]`, `/session list`, `/session resume <id|n>`, `/session close`',
    '• `/agents`, `/agent select <name|n>`',
    '',
    '*Configuration*:',
    '• `/config`, `/model <name>`, `/turns <n>`, `/budget <amt>`, `/render <compact|full|file>`',
    '',
    '*Execution*:',
    '• `/run <prompt>`, `/jobs`, `/job <id>`, `/cancel <id>`',
    '',
    '_Type `/help <command>` for specific command details (e.g. `/help run`)._',
  ].join('\n');
}
