import type { CommandContext } from './types.js';
import type { Project } from '../database/types.js';
import {
  getOrCreateProjectConfig,
  updateProjectConfig,
} from '../database/repositories/config.repo.js';
import { InvalidArgumentError } from '../router/errors.js';
import { fetchModelsForAgent } from '../agents/model-fetcher.js';
import {
  setSelectionCache,
  clearSelectionCache,
  resolveSelectionIndex,
  type SelectionItem,
} from '../state/selection-cache.js';
import { SUPPORTED_AGENTS } from './agent.cmd.js';

function requireProject(ctx: CommandContext): Project {
  if (!ctx.project) {
    throw new InvalidArgumentError(
      'No project selected.',
      'Select a project first with /project select <path>'
    );
  }
  return ctx.project;
}

export async function handleConfig(ctx: CommandContext): Promise<string> {
  if (!ctx.project) {
    return [
      '⚠️ *No project selected.*',
      '',
      'Select a project first:',
      '  `/project select <path>`',
    ].join('\n');
  }

  const { subcommand, args } = ctx.parsed;

  if (!subcommand) {
    return handleConfigShow(ctx);
  }

  switch (subcommand) {
    case 'show':
      return handleConfigShow(ctx);
    case 'model':
      return await handleConfigModel(ctx, args[0]);
    case 'permission':
      return handleConfigPermission(ctx, args[0]);
    case 'tools':
      return handleConfigTools(ctx, args[0], args.slice(1));
    case 'output':
      return handleConfigOutput(ctx, args[0]);
    case 'turns':
      return handleConfigTurns(ctx, args[0]);
    case 'budget':
      return handleConfigBudget(ctx, args[0]);
    case 'worktree':
      return handleConfigWorktree(ctx, args[0]);
    case 'mcp':
      return handleConfigMcp(ctx, args[0]);
    case 'render':
      return handleConfigRender(ctx, args[0]);
    default:
      throw new InvalidArgumentError(
        `Unknown config setting: "${subcommand}"`,
        'Use /config to view current configuration.'
      );
  }
}

export function handleConfigShow(ctx: CommandContext): string {
  const project = requireProject(ctx);
  const cfg = getOrCreateProjectConfig(project.id);
  const budgetStr = cfg.max_budget_usd !== null ? `$${cfg.max_budget_usd.toFixed(2)}` : 'unlimited';
  const worktreeStr = cfg.worktree_enabled ? `enabled (${cfg.worktree_branch || 'auto'})` : 'disabled';
  const mcpStr = cfg.mcp_config_path || 'default';

  return [
    '⚙️ *Execution & Display Configuration*',
    '',
    '*Agent Execution (CLI)*:',
    `• Model:        \`${cfg.model}\``,
    `• Permission:   \`${cfg.permission_mode}\``,
    `• Output:       \`${cfg.agent_output_format}\` (CLI flag)`,
    `• Max Turns:    ${cfg.max_turns}`,
    `• Budget Cap:   ${budgetStr}`,
    `• Worktree:     ${worktreeStr}`,
    `• MCP Config:   ${mcpStr}`,
    '',
    '*WhatsApp Presentation*:',
    `• Render:       \`${cfg.render_mode}\``,
    `• Preview Tail: ${cfg.render_max_excerpt_lines} lines`,
    `• Show Diffs:   ${cfg.render_show_diff ? 'Yes' : 'No'}`,
    '',
    '_Modify with `/model <name>`, `/turns <n>`, `/render <mode>`._',
  ].join('\n');
}

export async function handleConfigModel(ctx: CommandContext, modelName?: string): Promise<string> {
  const project = requireProject(ctx);
  const currentAgent = project.selected_agent && project.selected_agent !== 'none'
    ? project.selected_agent
    : 'claude';
  const cfg = getOrCreateProjectConfig(project.id);

  // If no model provided or user requested 'list', show interactive numbered options menu
  if (!modelName || modelName.toLowerCase() === 'list') {
    const models = await fetchModelsForAgent(currentAgent);
    const agentMeta = SUPPORTED_AGENTS.find((a) => a.name === currentAgent);
    const agentLabel = agentMeta?.label || currentAgent;

    const selectionItems: SelectionItem[] = [];
    const lines: string[] = [
      `🎛️ *Select AI Model* (${agentLabel})`,
      '',
      '*Current Model*:',
      `  🟢 \`${cfg.model}\``,
      '',
      '*Available Models*:',
    ];

    models.forEach((m, idx) => {
      const index = idx + 1;
      const isActive = cfg.model === m.id;
      selectionItems.push({
        index,
        label: m.label,
        value: m.id,
        type: 'model',
      });
      lines.push(`  ${index}. ${isActive ? '🟢' : '⚪'} *${m.label}*${isActive ? ' (Active)' : ''}`);
      lines.push(`     \`${m.id}\``);
    });

    lines.push(
      '',
      `💬 _Reply with 1 to ${models.length} or type \`/model <name>\` to select model._`
    );

    setSelectionCache(ctx.user.id, 'MODEL_LIST', ctx.navCwd, selectionItems);
    return lines.join('\n');
  }

  // If user provided a numeric index (e.g. /model 1 or reply "1" from selection cache)
  let finalModel = modelName;
  if (/^\d+$/.test(modelName)) {
    const index = parseInt(modelName, 10);
    const item = resolveSelectionIndex(ctx.user.id, index, undefined, 'model');
    finalModel = item.value;
  } else {
    const normalized = modelName.toLowerCase();
    const mapping: Record<string, string> = {
      sonnet: 'claude-3-7-sonnet',
      opus: 'claude-3-opus',
      haiku: 'claude-3-5-haiku',
      flash: 'gemini-3.8-flash-high',
      pro: 'gemini-3.1-pro-high',
    };
    finalModel = mapping[normalized] || modelName;
  }

  updateProjectConfig(project.id, { model: finalModel });
  clearSelectionCache(ctx.user.id);

  return [
    '✅ *Execution Model Updated*',
    '',
    `• *Agent*: \`${currentAgent}\``,
    `• *Model*: \`${finalModel}\``,
    '',
    '_Ready for tasks! Ask anything or type `/run <task>`._',
  ].join('\n');
}

export function handleConfigPermission(ctx: CommandContext, mode?: string): string {
  const project = requireProject(ctx);
  if (!mode || !['plan', 'default', 'accept-all', 'bypass'].includes(mode.toLowerCase())) {
    throw new InvalidArgumentError(
      'Invalid permission mode.',
      'Valid choices: plan, default, accept-all, bypass.'
    );
  }

  const validMode = mode.toLowerCase() as 'plan' | 'default' | 'accept-all' | 'bypass';
  updateProjectConfig(project.id, { permission_mode: validMode });

  return `✅ Permission mode set to: \`${validMode}\``;
}

export function handleConfigTools(
  ctx: CommandContext,
  action?: string,
  toolNames: string[] = []
): string {
  const project = requireProject(ctx);
  if (!action || !['allow', 'deny', 'reset'].includes(action.toLowerCase())) {
    throw new InvalidArgumentError(
      'Action must be allow, deny, or reset.',
      'Usage: /tools <allow | deny | reset> [tool_names...]'
    );
  }

  const act = action.toLowerCase();
  const cfg = getOrCreateProjectConfig(project.id);
  let allowed: string[] = JSON.parse(cfg.allowed_tools);
  let denied: string[] = JSON.parse(cfg.denied_tools);

  if (act === 'reset') {
    allowed = [];
    denied = [];
  } else if (toolNames.length === 0) {
    throw new InvalidArgumentError(
      'Provide at least one tool name.',
      'Example: /tools deny WebSearch'
    );
  } else if (act === 'allow') {
    for (const t of toolNames) {
      if (!allowed.includes(t)) allowed.push(t);
      denied = denied.filter((d) => d !== t);
    }
  } else if (act === 'deny') {
    for (const t of toolNames) {
      if (!denied.includes(t)) denied.push(t);
      allowed = allowed.filter((a) => a !== t);
    }
  }

  updateProjectConfig(project.id, {
    allowed_tools: JSON.stringify(allowed),
    denied_tools: JSON.stringify(denied),
  });

  return [
    '🛠️ *Tool Permissions Updated*',
    `Allowed: [${allowed.join(', ') || 'None'}]`,
    `Denied: [${denied.join(', ') || 'None'}]`,
  ].join('\n');
}

export function handleConfigOutput(ctx: CommandContext, format?: string): string {
  const project = requireProject(ctx);
  if (!format || !['json', 'text', 'stream-json'].includes(format.toLowerCase())) {
    throw new InvalidArgumentError(
      'Invalid output format.',
      'Supported agent CLI output formats: json, text, stream-json.'
    );
  }

  const validFormat = format.toLowerCase() as 'json' | 'text' | 'stream-json';
  updateProjectConfig(project.id, { agent_output_format: validFormat });

  return `✅ Agent CLI output format set to: \`${validFormat}\``;
}

export function handleConfigTurns(ctx: CommandContext, turnsStr?: string): string {
  const project = requireProject(ctx);
  const turns = turnsStr ? parseInt(turnsStr, 10) : NaN;
  if (isNaN(turns) || turns < 1 || turns > 50) {
    throw new InvalidArgumentError(
      'Max turns must be an integer between 1 and 50.',
      'Usage: /turns 10'
    );
  }

  updateProjectConfig(project.id, { max_turns: turns });
  return `✅ Max turns set to: \`${turns}\``;
}

export function handleConfigBudget(ctx: CommandContext, budgetStr?: string): string {
  const project = requireProject(ctx);
  if (!budgetStr) {
    throw new InvalidArgumentError(
      'Budget amount or "none" required.',
      'Usage: /budget 2.50 or /budget none'
    );
  }

  if (budgetStr.toLowerCase() === 'none') {
    updateProjectConfig(project.id, { max_budget_usd: null });
    return '✅ Budget cap removed (unlimited).';
  }

  const amount = parseFloat(budgetStr.replace('$', ''));
  if (isNaN(amount) || amount <= 0) {
    throw new InvalidArgumentError(
      'Budget must be a positive number.',
      'Example: /budget 2.00'
    );
  }

  updateProjectConfig(project.id, { max_budget_usd: amount });
  return `✅ Budget cap set to: \`$${amount.toFixed(2)}\``;
}

export function handleConfigWorktree(ctx: CommandContext, mode?: string): string {
  const project = requireProject(ctx);
  if (!mode || !['enable', 'disable'].includes(mode.toLowerCase())) {
    throw new InvalidArgumentError(
      'Mode must be enable or disable.',
      'Usage: /worktree <enable | disable>'
    );
  }

  const enabled = mode.toLowerCase() === 'enable' ? 1 : 0;
  updateProjectConfig(project.id, { worktree_enabled: enabled });

  return `🌿 Git worktree isolation: \`${enabled ? 'ENABLED' : 'DISABLED'}\``;
}

export function handleConfigMcp(ctx: CommandContext, mcpPath?: string): string {
  const project = requireProject(ctx);
  if (!mcpPath) {
    throw new InvalidArgumentError(
      'MCP config path or "none" required.',
      'Usage: /mcp .claude/mcp.json or /mcp none'
    );
  }

  const value = mcpPath.toLowerCase() === 'none' ? null : mcpPath;
  updateProjectConfig(project.id, { mcp_config_path: value });

  return `🔌 MCP Configuration: \`${value || 'DISABLED'}\``;
}

export function handleConfigRender(ctx: CommandContext, mode?: string): string {
  const project = requireProject(ctx);
  if (!mode || !['compact', 'full', 'file'].includes(mode.toLowerCase())) {
    throw new InvalidArgumentError(
      'Render mode must be compact, full, or file.',
      'Usage: /render <compact | full | file>'
    );
  }

  const validMode = mode.toLowerCase() as 'compact' | 'full' | 'file';
  updateProjectConfig(project.id, { render_mode: validMode });

  return [
    `📺 *WhatsApp Presentation Mode: ${validMode.toUpperCase()}*`,
    validMode === 'compact'
      ? 'Output will be delivered as concise summaries with changed file lists.'
      : validMode === 'full'
      ? 'Full raw output will be delivered in paginated text messages.'
      : 'Full logs will be attached as downloadable documents.',
  ].join('\n');
}
