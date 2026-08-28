import type { CommandContext } from './types.js';
import { getActiveSession } from '../database/repositories/session.repo.js';
import {
  getRecentJobs,
  getJobById,
  getJobOutput,
} from '../database/repositories/job.repo.js';
import { getOrCreateProjectConfig } from '../database/repositories/config.repo.js';
import { launchJob, cancelJob } from '../jobs/job-manager.js';
import {
  setSelectionCache,
  resolveSelectionIndex,
  type SelectionItem,
} from '../state/selection-cache.js';
import {
  InvalidArgumentError,
  NotFoundError,
  NoActiveSessionError,
} from '../router/errors.js';

export async function handleTask(ctx: CommandContext): Promise<string> {
  const { subcommand, args, rawTrailing } = ctx.parsed;

  switch (subcommand) {
    case 'run':
      return handleRun(ctx, rawTrailing || args.join(' '));
    case 'jobs':
      return handleJobs(ctx);
    case 'job':
      return handleJobDetail(ctx, args[0], args[1]);
    case 'cancel':
      return handleCancel(ctx, args[0]);
    default:
      // If user typed /task without subcommand, default to /jobs
      return handleJobs(ctx);
  }
}

export async function handleRun(ctx: CommandContext, prompt?: string): Promise<string> {
  const cleanPrompt = prompt?.trim();
  if (!cleanPrompt) {
    throw new InvalidArgumentError(
      'Prompt is required.',
      'Usage: /run <instruction> (e.g. /run Fix the authentication bug)'
    );
  }

  const activeSession = getActiveSession(ctx.project.id);
  if (!activeSession) {
    throw new NoActiveSessionError();
  }

  const config = getOrCreateProjectConfig(ctx.project.id);
  const job = await launchJob(ctx.user.id, ctx.project, activeSession, cleanPrompt);

  return [
    `🚀 *Task #${job.id} Started*`,
    '',
    `Agent: ${ctx.project.selected_agent}`,
    `Session: \`${activeSession.name}\``,
    `Model: \`${config.model}\``,
    `Prompt: _"${cleanPrompt}"_`,
    '',
    `_Use \`/job ${job.id}\` for status or \`/cancel ${job.id}\` to abort._`,
  ].join('\n');
}

export function handleJobs(ctx: CommandContext): string {
  const jobs = getRecentJobs(ctx.user.id, 10);
  if (jobs.length === 0) {
    return 'ℹ️ No recent tasks found.\n👉 Start one with `/run <prompt>`.';
  }

  const selectionItems: SelectionItem[] = [];
  const lines: string[] = ['📋 *Background Jobs*', ''];

  jobs.forEach((j, idx) => {
    const index = idx + 1;
    let icon = '⚪';
    if (j.status === 'RUNNING') icon = '⏳';
    else if (j.status === 'COMPLETED') icon = '✅';
    else if (j.status === 'FAILED') icon = '❌';
    else if (j.status === 'CANCELLED' || j.status === 'CANCEL_REQUESTED') icon = '🛑';

    selectionItems.push({
      index,
      label: `#${j.id} (${j.status})`,
      value: String(j.id),
      type: 'job',
    });

    const promptPreview =
      j.prompt.length > 35 ? j.prompt.slice(0, 32) + '...' : j.prompt;
    const duration = j.duration_ms
      ? `${Math.round(j.duration_ms / 1000)}s`
      : 'running';

    lines.push(
      `${index}. ${icon} *#${j.id}* | *${j.status}* (${duration})\n   _${promptPreview}_`
    );
  });

  lines.push('', '_View details with `/job <id>` or `/cancel <id>`._');

  setSelectionCache(ctx.user.id, 'JOB_LIST', ctx.project.cwd, selectionItems);

  return lines.join('\n');
}

export function handleJobDetail(
  ctx: CommandContext,
  target?: string,
  viewMode?: string
): string {
  if (!target) {
    throw new InvalidArgumentError(
      'Job ID or index required.',
      'Usage: /job <id | index> [full]'
    );
  }

  let jobId: number;
  const cleanTarget = target.replace(/^#/, '');

  if (/^\d+$/.test(cleanTarget)) {
    // Check if target matches index from latest selection cache first
    try {
      const index = parseInt(cleanTarget, 10);
      const item = resolveSelectionIndex(ctx.user.id, index, undefined, 'job');
      jobId = parseInt(item.value, 10);
    } catch {
      // Fallback: direct job id
      jobId = parseInt(cleanTarget, 10);
    }
  } else {
    throw new InvalidArgumentError('Invalid job ID.', 'Usage: /job <id>');
  }

  const job = getJobById(jobId);
  if (!job || job.user_id !== ctx.user.id) {
    throw new NotFoundError('Job', `#${jobId}`);
  }

  const isFull = viewMode?.toLowerCase() === 'full';
  const durationSec = job.duration_ms ? `${Math.round(job.duration_ms / 1000)}s` : 'running';
  const costStr = job.cost_usd !== null ? `$${job.cost_usd.toFixed(2)}` : 'N/A';

  if (isFull) {
    const output = getJobOutput(job.id);
    const text = output?.stdout || output?.stderr || 'No output recorded.';
    // Bound excerpt for WhatsApp
    const lines = text.split('\n');
    const tailLines = lines.slice(-40).join('\n');

    return [
      `📊 *Job #${job.id} Full Output (Last 40 lines)*`,
      '```text',
      tailLines,
      '```',
    ].join('\n');
  }

  const detailsLines = [
    `📊 *Job #${job.id} Details*`,
    '',
    `Status: *${job.status}*`,
    `Exit Code: ${job.exit_code ?? 'N/A'}`,
    `Duration: ${durationSec}`,
    `Cost: ${costStr} (Turns: ${job.turns_used ?? 'N/A'})`,
    `Prompt: _"${job.prompt}"_`,
    '',
    `*Summary*:`,
    job.summary || '_No summary available._',
  ];

  if (job.stdout_truncated || job.stderr_truncated) {
    detailsLines.push('', '⚠️ _Output exceeded 5MB memory limit and was truncated._');
  }

  detailsLines.push('', `_For raw output, use \`/job ${job.id} full\`._`);
  return detailsLines.join('\n');
}

export async function handleCancel(ctx: CommandContext, target?: string): Promise<string> {
  if (!target) {
    throw new InvalidArgumentError(
      'Job ID or index required.',
      'Usage: /cancel <id | index>'
    );
  }

  let jobId: number;
  const cleanTarget = target.replace(/^#/, '');

  if (/^\d+$/.test(cleanTarget)) {
    try {
      const index = parseInt(cleanTarget, 10);
      const item = resolveSelectionIndex(ctx.user.id, index, undefined, 'job');
      jobId = parseInt(item.value, 10);
    } catch {
      jobId = parseInt(cleanTarget, 10);
    }
  } else {
    throw new InvalidArgumentError('Invalid job ID.', 'Usage: /cancel <id>');
  }

  await cancelJob(jobId, ctx.user.id);

  return [
    `🛑 *Cancel Requested for Job #${jobId}*`,
    'Process termination signal sent. Lock will be released once process exits.',
  ].join('\n');
}
