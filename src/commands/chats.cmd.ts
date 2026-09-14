import type { CommandContext } from './types.js';
import { scanAllNativeChats, type NativeChat } from '../sessions/native-session-scanner.js';
import {
  setSelectionCache,
  getSelectionCache,
  clearSelectionCache,
} from '../state/selection-cache.js';
import {
  createOrAttachNativeSession,
  getActiveSession,
} from '../database/repositories/session.repo.js';
import {
  updateSelectedAgent,
  getOrCreateProject,
  setActiveProject,
} from '../database/repositories/project.repo.js';
import { InvalidArgumentError, NotFoundError } from '../router/errors.js';
import { SUPPORTED_AGENTS } from './agent.cmd.js';

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export async function handleChats(ctx: CommandContext): Promise<string> {
  const { subcommand, args } = ctx.parsed;

  if (subcommand === 'select' || subcommand === 'open' || subcommand === 'resume') {
    return handleChatSelect(ctx, args[0]);
  }

  // If argument is a number, treat as selection
  if (subcommand && /^\d+$/.test(subcommand)) {
    return handleChatSelect(ctx, subcommand);
  }

  // Otherwise treat subcommand as optional agent filter (e.g. /chats codex or /chats list)
  const filter = subcommand === 'list' ? args[0] : subcommand;
  return handleChatsList(ctx, filter);
}

export async function handleChatsList(
  ctx: CommandContext,
  filterAgent?: string
): Promise<string> {
  const chats = await scanAllNativeChats(filterAgent, 10);

  if (chats.length === 0) {
    const filterNote = filterAgent ? ` for agent "${filterAgent}"` : '';
    return [
      `💬 *No recent desktop chats found${filterNote}.*`,
      '',
      'You can start a new session anytime with:',
      '  `/session create [name]`',
      '  or simply reply with `/run <prompt>`.',
    ].join('\n');
  }

  const lines: string[] = [
    '💬 *Recent Desktop / Terminal Chats*',
    filterAgent ? `_Filtered by agent: *${filterAgent}*_` : '',
    '',
  ].filter(Boolean);

  const selectionItems = chats.map((chat, idx) => {
    const num = idx + 1;
    const timeStr = formatRelativeTime(chat.updatedAt);
    const turnsStr = chat.turns ? ` (${chat.turns} turns)` : '';
    const wsName = chat.workspace ? `\n   📁 \`${chat.workspace.split('/').pop() || chat.workspace}\`` : '';

    lines.push(
      `${num}. 🧠 *${chat.agentLabel}* · _${timeStr}_`,
      `   📌 "${chat.title.slice(0, 48)}"${turnsStr}${wsName}`,
      ''
    );

    return {
      index: num,
      label: chat.title,
      value: chat.id,
      type: 'native_chat' as const,
      metadata: {
        agent: chat.agent,
        agentLabel: chat.agentLabel,
        title: chat.title,
        id: chat.id,
        workspace: chat.workspace,
      },
    };
  });

  lines.push(
    '👉 *Reply with a number (1-' + chats.length + ') to open in WhatsApp.*',
    '_Or filter by agent: `/chats codex`, `/chats agy`, `/chats opencode`_'
  );

  setSelectionCache(ctx.user.id, 'NATIVE_CHAT_LIST', ctx.navCwd, selectionItems);

  return lines.join('\n');
}

export async function handleChatSelect(
  ctx: CommandContext,
  target?: string
): Promise<string> {
  if (!target) {
    throw new InvalidArgumentError(
      'Target chat selection is required.',
      'Specify a number from /chats (e.g. /chats select 1).'
    );
  }

  let selectedChat: NativeChat | undefined;

  // 1. Try resolving via numeric selection cache
  const isNumeric = /^\d+$/.test(target);
  if (isNumeric) {
    const cache = getSelectionCache(ctx.user.id);
    if (cache && cache.source === 'NATIVE_CHAT_LIST') {
      const idx = parseInt(target, 10);
      const item = cache.items[idx - 1];
      if (item && item.metadata) {
        selectedChat = {
          agent: item.metadata.agent,
          agentLabel: item.metadata.agentLabel,
          id: item.metadata.id,
          title: item.metadata.title,
          updatedAt: new Date(),
          workspace: item.metadata.workspace,
        };
      }
    }
  }

  // 2. Fallback: scan to find by direct ID or index
  if (!selectedChat) {
    const all = await scanAllNativeChats(undefined, 25);
    if (isNumeric) {
      const idx = parseInt(target, 10);
      selectedChat = all[idx - 1];
    } else {
      selectedChat = all.find(
        (c) => c.id.toLowerCase() === target.toLowerCase() || c.id.startsWith(target)
      );
    }
  }

  if (!selectedChat) {
    throw new NotFoundError(
      `Chat #${target} not found.`,
      'Type `/chats` to see available desktop conversations.'
    );
  }

  // Ensure active project
  let project = ctx.project;
  if (!project) {
    const targetDir = selectedChat.workspace || ctx.navCwd;
    project = getOrCreateProject(ctx.user.id, targetDir);
    setActiveProject(ctx.user.id, project.id);
  }

  // Switch project agent to match the chat's agent
  updateSelectedAgent(project.id, selectedChat.agent);

  // Bind or create active session with nativeSessionRef
  const sessionName = selectedChat.title.slice(0, 32);
  const session = createOrAttachNativeSession(
    project.id,
    ctx.user.id,
    sessionName,
    selectedChat.agent,
    project.cwd,
    selectedChat.id
  );

  clearSelectionCache(ctx.user.id);

  const shortId = session.id.replace(/^sess_/, '');

  return [
    '✨ *Desktop Chat Connected!*',
    '',
    `*Session*:   #${shortId} (*${session.name}*)`,
    `*Agent*:     ${selectedChat.agentLabel}`,
    `*Project*:   ${project.name}`,
    `*Ref*:       \`${selectedChat.id.slice(0, 16)}...\``,
    '',
    'Ready. All previous conversation history is loaded.',
    '',
    'Continue this chat:',
    '👉 `/run <your prompt>`',
  ].join('\n');
}
