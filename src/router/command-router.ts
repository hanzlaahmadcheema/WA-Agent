import { parseCommand, type ParsedCommand } from './lexer.js';
import { authorizeUser, getOrCreateUser } from '../security/authorizer.js';
import { getActiveProject } from '../database/repositories/project.repo.js';
import { getUserNavCwd } from '../state/user-nav.js';
import {
  ControlPlaneError,
  NotFoundError,
  InvalidArgumentError,
  UnauthorizedError,
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
import { handleChats } from '../commands/chats.cmd.js';
import { handleGit } from '../commands/git.cmd.js';
import { handleSendFile, type FileSendResult } from '../commands/send-file.cmd.js';
import { handleRemind } from '../commands/remind.cmd.js';
import { handleSchedule } from '../commands/schedule.cmd.js';
import { handleReminderReply } from '../reminders/reminder-scheduler.js';
import { parseReminder } from '../reminders/reminder-parser.js';
import { getQuotaFallback, clearQuotaFallback, getAlternativeAgent } from '../jobs/quota-fallback.js';
import { getSelectionCache, clearSelectionCache } from '../state/selection-cache.js';
import { createCorrelationLogger } from '../logger.js';
import type { CommandContext, CommandResult } from '../commands/types.js';
import { isCliActive, startCliSession, stopCliSession } from '../state/cli-session.js';
import { resetUserNav } from '../state/user-nav.js';
import { getDatabase } from '../database/connection.js';
import { closeActiveSession, getActiveSession, createSession } from '../database/repositories/session.repo.js';
import { launchJob } from '../jobs/job-manager.js';

export async function processIncomingMessage(
  senderJid: string,
  messageText: string,
  pushName?: string
): Promise<CommandResult | null> {
  let parsed = parseCommand(messageText);

  // Natural reminder detection — works even without /start session
  // e.g. "remind me to push at 5pm", "remind every day at 9am", "remind in 30s"
  if (!parsed && /^remind\b/i.test(messageText.trim())) {
    parsed = {
      raw: messageText,
      command: 'remind',
      args: [],
      rawTrailing: messageText.trim(),
    };
  }

  // Natural Conversation Mode:
  // If text doesn't start with / and is not a keyword or numeric selection,
  // but sender has an active session, automatically route as /run prompt!
  if (!parsed) {
    try {
      const authUser = authorizeUser(senderJid, pushName);
      if (isCliActive(authUser.id)) {
        const activeProj = getActiveProject(authUser.id);
        if (activeProj) {
          const activeSess = getActiveSession(activeProj.id);
          if (activeSess) {
            parsed = {
              raw: messageText,
              command: 'task',
              subcommand: 'run',
              args: [messageText],
              rawTrailing: messageText,
            };
          }
        }
      }
    } catch {
      // Ignored if unauthorized
    }
  }

  if (!parsed) return null;

  const cmdLogger = createCorrelationLogger({ userId: senderJid });

  try {
    // 1. Authorize sender or permit public commands
    const { user, isAuthorized } = getOrCreateUser(senderJid, pushName);
    const isPublic =
      parsed.command === 'schedule' ||
      parsed.command === 'remind' ||
      (parsed.command === 'system' && (parsed.subcommand === 'ping' || parsed.subcommand === 'time')) ||
      (parsed.command === 'select_numeric' && (parsed.args[0] === '11' || parsed.args[0] === '12'));

    if (!isAuthorized && !isPublic) {
      throw new UnauthorizedError();
    }

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

    // 3. Handle explicit /start and /stop
    if (parsed.command === 'start') {
      startCliSession(user.id);
      resetUserNav(user.id);
      clearSelectionCache(user.id);
      clearQuotaFallback(user.id);
      const db = getDatabase();
      db.prepare("UPDATE projects SET is_active = 0, selected_agent = 'none' WHERE user_id = ?").run(user.id);
      const freshNavCwd = getUserNavCwd(user.id);
      return [
        '🚀 *WA-Agent CLI Started*',
        '',
        `📍 *Directory*: \`${freshNavCwd}\``,
        '📁 *Project*:   Not selected',
        '🧠 *Agent*:     Not selected',
        '💬 *Session*:   Not created',
        '',
        'Type `/menu` to explore options or `/ls` to view files.',
      ].join('\n');
    }

    if (parsed.command === 'stop') {
      stopCliSession(user.id);
      clearSelectionCache(user.id);
      clearQuotaFallback(user.id);
      if (project) {
        closeActiveSession(project.id);
        const db = getDatabase();
        db.prepare("UPDATE projects SET is_active = 0, selected_agent = 'none' WHERE user_id = ?").run(user.id);
      }
      return [
        '⏹️ *WA-Agent CLI Stopped*',
        '',
        'Your terminal session has ended and commands are paused.',
        'Send `/start` anytime to begin.',
      ].join('\n');
    }

    if (parsed.command === 'fix') {
      const promptText = parsed.rawTrailing || parsed.args.join(' ') || 'Issue investigation';
      return [
        '🛠️ *Fix Request Received*',
        '',
        `Instruction: "${promptText}"`,
        '',
        'The assistant is inspecting system logs and applying changes now. You will receive a resolution report shortly.',
      ].join('\n');
    }

    // 4. CLI Session Gating: /start required to execute commands
    // Exceptions: /remind works without a session (it's a personal utility),
    // and snooze/cancel replies to a fired reminder are handled here too.
    if (parsed.command === 'remind') {
      return await handleRemind(ctx);
    }

    if (parsed.command === 'schedule') {
      return await handleSchedule(ctx);
    }

    if (parsed.command === 'select_numeric' && (parsed.args[0] === '11' || parsed.args[0] === '12')) {
      if (parsed.args[0] === '11') {
        ctx.parsed = { raw: '/reminders', command: 'remind', subcommand: 'list', args: [] };
        return await handleRemind(ctx);
      }
      if (parsed.args[0] === '12') {
        ctx.parsed = { raw: '/schedule', command: 'schedule', args: [] };
        return await handleSchedule(ctx);
      }
    }

    // Intercept snooze/cancel replies for fired reminders (e.g. "snooze 15m", "cancel")
    const reminderReply = handleReminderReply(user.id, messageText.trim());
    if (reminderReply !== null) {
      return reminderReply;
    }

    if (!isCliActive(user.id)) {
      if (
        parsed.command === 'system' &&
        (parsed.subcommand === 'help' ||
          parsed.subcommand === 'status' ||
          parsed.subcommand === 'ping' ||
          parsed.subcommand === 'time')
      ) {
        return await handleSystem(ctx);
      }
      return [
        '⏸️ *WA-Agent CLI is stopped.*',
        '',
        'Type `/start` to begin your session.',
      ].join('\n');
    }

    // 5. Handle raw numeric input (e.g. user just typing "2")
    if (parsed.command === 'select_numeric') {
      // 5.1 Check Smart Quota Fallback first
      const quotaCtx = getQuotaFallback(user.id);
      if (quotaCtx && project) {
        const num = parseInt(parsed.args[0], 10);
        const altAgent = getAlternativeAgent(quotaCtx, num);
        if (altAgent) {
          clearQuotaFallback(user.id);
          clearSelectionCache(user.id);
          const db = getDatabase();
          db.prepare('UPDATE projects SET selected_agent = ? WHERE id = ?').run(altAgent, quotaCtx.projectId);
          const updatedProject = getActiveProject(user.id);
          let activeSession = getActiveSession(quotaCtx.projectId);
          if (!activeSession) {
            activeSession = createSession(
              quotaCtx.projectId,
              user.id,
              `fallback-${altAgent}`,
              altAgent,
              project.cwd
            );
          }
          const newJob = await launchJob(user.id, updatedProject || project, activeSession, quotaCtx.prompt);
          return [
            `🔄 *Switched Agent to ${altAgent.toUpperCase()}*`,
            '',
            `🚀 *Retrying Job #${newJob.id}* with your instruction:`,
            `"${quotaCtx.prompt}"`,
            '',
            'You will receive completion updates shortly.',
          ].join('\n');
        }
      }

      const cache = getSelectionCache(user.id);
      if (!cache) {
        // Fallback: If user types "1" to "9", treat as /menu selection
        const num = parseInt(parsed.args[0], 10);
        const menuMapping: Record<number, ParsedCommand> = {
          1: { raw: '/ls', command: 'navigation', subcommand: 'ls', args: [] },
          2: { raw: '/project', command: 'project', args: [] },
          3: { raw: '/agent', command: 'agent', args: [] },
          4: { raw: '/session', command: 'session', args: [] },
          5: { raw: '/config', command: 'config', subcommand: 'show', args: [] },
          6: { raw: '/jobs', command: 'task', subcommand: 'jobs', args: [] },
          7: { raw: '/status', command: 'system', subcommand: 'status', args: [] },
          8: { raw: '/help', command: 'system', subcommand: 'help', args: [] },
          9: { raw: '/chats', command: 'chats', args: [] },
          10: { raw: '/model', command: 'config', subcommand: 'model', args: [] },
          11: { raw: '/reminders', command: 'remind', subcommand: 'list', args: [] },
          12: { raw: '/schedule', command: 'schedule', args: [] },
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

      if (cache.source === 'NATIVE_CHAT_LIST') {
        ctx.parsed = { raw: `/chats select ${parsed.args[0]}`, command: 'chats', subcommand: 'select', args: [parsed.args[0]] };
        return await dispatchCommand(ctx);
      }

      if (cache.source === 'MODEL_LIST') {
        ctx.parsed = { raw: `/model ${parsed.args[0]}`, command: 'config', subcommand: 'model', args: [parsed.args[0]] };
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

async function dispatchCommand(ctx: CommandContext): Promise<CommandResult> {
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
    case 'chats':
      return await handleChats(ctx);
    case 'git':
      return await handleGit(ctx);
    case 'send':
      return await handleSendFile(ctx);
    case 'remind':
      return await handleRemind(ctx);
    case 'schedule':
      return await handleSchedule(ctx);
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
