import type { CommandContext } from './types.js';
import { getActiveSession } from '../database/repositories/session.repo.js';
import { getOrCreateProjectConfig } from '../database/repositories/config.repo.js';
import { SUPPORTED_AGENTS } from './agent.cmd.js';

export function handleMenu(ctx: CommandContext): string {
  const dirDisplay = ctx.navCwd;
  const projDisplay = ctx.project ? ctx.project.name : 'Not selected';

  let agentDisplay = 'Not selected';
  if (ctx.project?.selected_agent && ctx.project.selected_agent !== 'none') {
    const meta = SUPPORTED_AGENTS.find((a) => a.name === ctx.project!.selected_agent);
    agentDisplay = meta?.label || ctx.project.selected_agent;
  }

  let modelDisplay = 'Default';
  if (ctx.project) {
    const cfg = getOrCreateProjectConfig(ctx.project.id);
    if (cfg.model) {
      modelDisplay = cfg.model;
    }
  }

  let sessionDisplay = 'Not created';
  if (ctx.project) {
    const activeSession = getActiveSession(ctx.project.id);
    if (activeSession) {
      sessionDisplay = `#${activeSession.id.replace(/^sess_/, '')}`;
    }
  }

  const isReady =
    Boolean(ctx.project &&
    ctx.project.selected_agent &&
    ctx.project.selected_agent !== 'none' &&
    sessionDisplay !== 'Not created');

  const statusLine = isReady ? '🟢 Ready' : '🟡 Setup required';

  const userGuide = isReady
    ? [
        '✨ *AI is ready for tasks!*',
        '👉 *Chat naturally:* Send any question or task, voice note, or screenshot!',
        '   _Commands: `/model`, `/run <task>`, `/diff`, `/commit <msg>`, `/send <file>`_',
      ].join('\n')
    : [
        '👉 *To get started:*',
        !ctx.project
          ? '   Reply *2* to choose a project folder.'
          : !ctx.project.selected_agent || ctx.project.selected_agent === 'none'
            ? '   Reply *3* to choose an AI agent.'
            : '   Reply *4* to create a chat session.',
      ].join('\n');

  const lines = [
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
    '🎛️ *Model*',
    `  ${modelDisplay}`,
    '',
    '💬 *Session*',
    `  ${sessionDisplay}`,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `*STATUS*: ${statusLine}`,
    '━━━━━━━━━━━━━━━━━━━━',
    userGuide,
    '',
    '🔢 *Quick Menu (Reply 1-11):*',
    '  1️⃣ 📁 *Browse Files* (`/ls`)',
    '  2️⃣ 📦 *Choose Project* (`/project`)',
    '  3️⃣ 🧠 *Choose AI Agent* (`/agent`)',
    '  4️⃣ 💬 *Chat Sessions* (`/session`)',
    '  5️⃣ ⚙️ *AI Settings* (`/config`)',
    '  6️⃣ 📋 *Tasks & Results* (`/jobs`)',
    '  7️⃣ 📊 *System Status* (`/status`)',
    '  8️⃣ ❓ *Help & Guide* (`/help`)',
    '  9️⃣ 💻 *Desktop Chats* (`/chats`)',
    '  🔟 🎛️ *Choose Model* (`/model`)',
    '  1️⃣1️⃣ ⏰ *Reminders* (`/reminders`)',
    '  1️⃣2️⃣ 🎓 *Uni Schedule* (`/schedule`)',
    '',
    '*Navigation*',
    '  `/ls [path]`   • Browse folders & files',
    '  `/cd <path|n>` • Open folder or select file',
    '  `/pwd`         • Current location',
    '  `/back`        • Go up one level',
    '',
    '*AI Commands*',
    '  `/run <prompt>`  • Run any task or question',
    '  `/model [name]`  • Switch model for current agent',
    '  `/chats [agent]` • Open recent terminal/GUI chats',
    '  `/jobs`          • View active & recent tasks',
    '  `/cancel <id>`   • Stop a running task',
    '',
    '*Git & Files*',
    '  `/diff`          • Review changed files & diffs',
    '  `/commit <msg>`  • Commit project changes',
    '  `/push`          • Push commits to git remote',
    '  `/send <file|n>` • Send file or image back to WhatsApp',
    '',
    '*Reminders* _(Public)_',
    '  `/remind 30m check the build`',
    '  `/remind at 5pm push the release`',
    '  `/remind tomorrow 9am standup`',
    '  `/reminders`     • View all pending reminders',
    '  `remind me to X at 5pm`  _(plain text works too!)_',
    '',
    '*University Schedule* _(Public)_',
    '  `/schedule`           • Today\'s classes with live status',
    '  `/schedule next`      • Next lecture countdown',
    '  `/schedule remaining` • Remaining classes today',
    '  `/schedule week`      • Full weekly timetable',
    '  `/schedule <day>`     • Specific day (e.g. `/schedule friday`)',
    '',
    '*Session Control*',
    '  `/start` • Start or reset assistant',
    '  `/stop`  • Pause assistant',
    '  `/menu`  • Re-open this menu',
    '',
    '💡 *Tip for non-technical users:*',
    'Simply reply with *1* to *12* above to navigate without typing commands!',
  ];
  return lines.join('\n');
}
