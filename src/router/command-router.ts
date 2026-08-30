import { parseCommand, type ParsedCommand } from './lexer.js';
import { authorizeUser } from '../security/authorizer.js';
import { getActiveProject } from '../database/repositories/project.repo.js';
import { getUserNavCwd } from '../state/user-nav.js';
import {
  ControlPlaneError,
  NotFoundError,
  InvalidArgumentError,
} from './errors.js';
import { handleMenu } from '../commands/menu.cmd.js';
import { handleNavigation } from '../commands/navigation.cmd.js';
import { handleFiles } from '../commands/files.cmd.js';
import { handleProject } from '../commands/project.cmd.js';
import { handleAgent } from '../commands/agent.cmd.js';
import { handleSession } from '../commands/session.cmd.js';
import { handleConfig } from '../commands/config.cmd.js';
import { handleTask } from '../commands/task.cmd.js';
import { handleSystem } from '../commands/system.cmd.js';
import { getSelectionCache } from '../state/selection-cache.js';
import { createCorrelationLogger } from '../logger.js';
import type { CommandContext } from '../commands/types.js';

export async function processIncomingMessage(
  senderJid: string,
  messageText: string,
  pushName?: string
): Promise<string | null> {
  const parsed = parseCommand(messageText);
  if (!parsed) return null;

  const cmdLogger = createCorrelationLogger({ userId: senderJid });

  try {
    // 1. Authorize sender
    const user = authorizeUser(senderJid, pushName);

    // 2. Resolve active project (if selected) and terminal navigation directory
    const project = getActiveProject(user.id);
    const navCwd = getUserNavCwd(user.id);

    const ctx: CommandContext = {
      user,
      project,
      parsed,
      navCwd,
    };

    cmdLogger.info(
      {
        command: parsed.command,
        subcommand: parsed.subcommand,
        argsCount: parsed.args.length,
      },
      'command.received'
    );

    // 3. Handle raw numeric input (e.g. user just typing "2")
    if (parsed.command === 'select_numeric') {
      const cache = getSelectionCache(user.id);
      if (!cache) {
        // Fallback: If user types "1" to "7", treat as /menu selection
        const num = parseInt(parsed.args[0], 10);
        const menuMapping: Record<number, ParsedCommand> = {
          1: { raw: '/ls', command: 'navigation', subcommand: 'ls', args: [] },
          2: { raw: '/project', command: 'project', args: [] },
          3: { raw: '/agent', command: 'agent', args: [] },
          4: { raw: '/session', command: 'session', args: [] },
          5: { raw: '/config', command: 'config', subcommand: 'show', args: [] },
          6: { raw: '/jobs', command: 'task', subcommand: 'jobs', args: [] },
          7: { raw: '/status', command: 'system', subcommand: 'status', args: [] },
        };

        if (menuMapping[num]) {
          ctx.parsed = menuMapping[num];
          return await dispatchCommand(ctx);
        }

        throw new InvalidArgumentError(
          `Index #${parsed.args[0]} has no active listing context.`,
          'Type /menu, /ls, or /jobs to view numbered options.'
        );
      }

      // If active selection cache is NAVIGATION_LS:
      if (cache.source === 'NAVIGATION_LS') {
        const index = parseInt(parsed.args[0], 10);
        const item = cache.items[index - 1];
        if (!item) {
          throw new InvalidArgumentError(
            `Index #${index} is out of range.`,
            `Valid range: 1 to ${cache.items.length}.`
          );
        }
        if (item.type === 'dir') {
          ctx.parsed = { raw: `/cd ${index}`, command: 'navigation', subcommand: 'cd', args: [String(index)] };
        } else {
          ctx.parsed = { raw: `/view ${index}`, command: 'files', subcommand: 'view', args: [String(index)] };
        }
        return await dispatchCommand(ctx);
      }

      if (cache.source === 'SESSION_LIST') {
        ctx.parsed = { raw: `/session select ${parsed.args[0]}`, command: 'session', subcommand: 'select', args: [parsed.args[0]] };
        return await dispatchCommand(ctx);
      }

      if (cache.source === 'AGENT_LIST') {
        ctx.parsed = { raw: `/agent select ${parsed.args[0]}`, command: 'agent', subcommand: 'select', args: [parsed.args[0]] };
        return await dispatchCommand(ctx);
      }

      if (cache.source === 'JOB_LIST') {
        ctx.parsed = { raw: `/job ${parsed.args[0]}`, command: 'task', subcommand: 'job', args: [parsed.args[0]] };
        return await dispatchCommand(ctx);
      }
    }

    return await dispatchCommand(ctx);
  } catch (err: any) {
    if (err instanceof ControlPlaneError) {
      cmdLogger.warn(
        { category: err.category, reason: err.reason },
        'command.client_error'
      );
      return err.toWhatsApp();
    }
    cmdLogger.error(
      { error: err.message, stack: err.stack },
      'command.internal_error'
    );
    return `❌ *ERR_INTERNAL*: An unexpected error occurred.\n👉 Reason: ${err.message || 'Unknown internal error'}`;
  }
}

async function dispatchCommand(ctx: CommandContext): Promise<string> {
  const { command } = ctx.parsed;

  switch (command) {
    case 'menu':
      return handleMenu(ctx);
    case 'navigation':
      return await handleNavigation(ctx);
    case 'files':
      return await handleFiles(ctx);
    case 'project':
      return await handleProject(ctx);
    case 'agent':
      return await handleAgent(ctx);
    case 'session':
      return await handleSession(ctx);
    case 'config':
      return await handleConfig(ctx);
    case 'task':
      return await handleTask(ctx);
    case 'system':
      return await handleSystem(ctx);
    default:
      throw new NotFoundError(
        'Command',
        `/${command}`,
        'Type /menu or /help to view available commands.'
      );
  }
}
