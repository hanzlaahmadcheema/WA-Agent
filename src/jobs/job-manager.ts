import type { ChildProcess } from 'node:child_process';
import type { Project, Session, Job } from '../database/types.js';
import { getOrCreateProjectConfig } from '../database/repositories/config.repo.js';
import {
  createJob,
  updateJobRunning,
  finishJob,
  requestJobCancel,
  getJobById,
  saveJobOutput,
} from '../database/repositories/job.repo.js';
import { updateSessionMetrics } from '../database/repositories/session.repo.js';
import { acquireSessionLock, releaseSessionLock } from '../state/session-lock.js';
import { getAgentDriver } from '../agents/agent-registry.js';
import { spawnDetachedAgent, terminateProcessGroup } from './process-supervisor.js';
import { StreamCollector } from './stream-collector.js';
import {
  InvalidArgumentError,
  NotFoundError,
  JobCollisionError,
} from '../router/errors.js';

export type JobNotificationHandler = (userId: string, message: string) => Promise<void> | void;

let notificationHandler: JobNotificationHandler | null = null;

export function setJobNotificationHandler(handler: JobNotificationHandler | null): void {
  notificationHandler = handler;
}

interface ActiveProcessInfo {
  child: ChildProcess;
  sessionId: string;
  userId: string;
  stdoutCollector: StreamCollector;
  stderrCollector: StreamCollector;
}

const activeProcesses = new Map<number, ActiveProcessInfo>();

export async function launchJob(
  userId: string,
  project: Project,
  session: Session,
  prompt: string
): Promise<Job> {
  const config = getOrCreateProjectConfig(project.id);
  const driver = getAgentDriver(project.selected_agent);

  const commandArgs = driver.buildCommandArgs({
    prompt,
    cwd: project.cwd,
    config,
    sessionRef: session.agent_session_ref,
  });

  // Pre-flight check: create queued job record in DB
  const job = createJob({
    sessionId: session.id,
    projectId: project.id,
    userId,
    prompt,
    commandArgs,
  });

  try {
    acquireSessionLock(session.id, job.id);
  } catch (err) {
    finishJob(job.id, {
      status: 'FAILED',
      failureReason: 'PROCESS_ERROR',
      errorMessage: 'Session lock acquisition collision.',
    });
    throw err;
  }

  // Spawn detached process group
  let child: ChildProcess;
  try {
    child = spawnDetachedAgent(commandArgs[0], commandArgs.slice(1), project.cwd);
  } catch (err: any) {
    releaseSessionLock(session.id, job.id);
    finishJob(job.id, {
      status: 'FAILED',
      failureReason: 'PROCESS_ERROR',
      errorMessage: `Failed to spawn agent binary "${commandArgs[0]}": ${err.message}`,
    });
    throw new InvalidArgumentError(
      `Failed to launch agent binary "${commandArgs[0]}".`,
      'Verify that the CLI binary is installed and executable on the host.'
    );
  }

  // Attach error handler immediately before any PID check to prevent unhandled 'error' events
  child.on('error', (err: any) => {
    activeProcesses.delete(job.id);
    releaseSessionLock(session.id, job.id);

    finishJob(job.id, {
      status: 'FAILED',
      failureReason: 'PROCESS_ERROR',
      errorMessage: err.message,
    });

    if (notificationHandler) {
      notificationHandler(
        userId,
        `❌ *Job #${job.id} Failed to Launch*\n\nReason: ${err.message}`
      );
    }
  });

  const pid = child.pid;
  if (!pid) {
    releaseSessionLock(session.id, job.id);
    finishJob(job.id, {
      status: 'FAILED',
      failureReason: 'PROCESS_ERROR',
      errorMessage: `Failed to spawn agent binary "${commandArgs[0]}": Executable not found or not runnable.`,
    });
    throw new InvalidArgumentError(
      `Agent binary "${commandArgs[0]}" could not be launched.`,
      'Verify that the CLI binary is installed and executable on the host.'
    );
  }

  updateJobRunning(job.id, pid);

  const stdoutCollector = new StreamCollector();
  const stderrCollector = new StreamCollector();

  activeProcesses.set(job.id, {
    child,
    sessionId: session.id,
    userId,
    stdoutCollector,
    stderrCollector,
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutCollector.write(chunk);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrCollector.write(chunk);
  });

  child.on('close', (exitCode) => {
    try {
      activeProcesses.delete(job.id);

      const latestJob = getJobById(job.id);
      const wasCancelRequested = latestJob?.status === 'CANCEL_REQUESTED';

      const stdout = stdoutCollector.getString();
      const stderr = stderrCollector.getString();

      saveJobOutput(job.id, stdout, stderr);

      if (wasCancelRequested) {
        finishJob(job.id, {
          status: 'CANCELLED',
          exitCode,
          failureReason: 'USER_CANCEL',
          stdoutBytes: stdoutCollector.totalBytes,
          stderrBytes: stderrCollector.totalBytes,
          stdoutTruncated: stdoutCollector.truncated,
          stderrTruncated: stderrCollector.truncated,
        });

        if (notificationHandler) {
          notificationHandler(
            userId,
            `🛑 *Job #${job.id} Cancelled*\nProcess terminated.`
          );
        }
        return;
      }

      const isSuccess = exitCode === 0;
      const normalized = driver.normalizeOutput(stdout, stderr, exitCode);

      const finished = finishJob(job.id, {
        status: isSuccess ? 'COMPLETED' : 'FAILED',
        exitCode,
        failureReason: isSuccess ? null : 'PROCESS_ERROR',
        summary: normalized.summary,
        filesChanged: normalized.filesChanged,
        tokensIn: normalized.tokensIn,
        tokensOut: normalized.tokensOut,
        costUsd: normalized.costUsd,
        turnsUsed: normalized.turnsUsed,
        stdoutBytes: stdoutCollector.totalBytes,
        stderrBytes: stderrCollector.totalBytes,
        stdoutTruncated: stdoutCollector.truncated,
        stderrTruncated: stderrCollector.truncated,
      });

      // Update parent session totals
      updateSessionMetrics(
        session.id,
        normalized.turnsUsed || 1,
        normalized.tokensIn,
        normalized.tokensOut,
        normalized.costUsd
      );

      // Format WhatsApp completion notification
      if (notificationHandler) {
        const durationSec = Math.max(0, Math.round((finished.duration_ms || 0) / 1000));
        const icon = isSuccess ? '✅' : '❌';
        const statusText = isSuccess ? 'Completed' : 'Failed';

        const lines: string[] = [
          `${icon} *Job #${job.id} ${statusText}* (Exit: ${exitCode ?? 'N/A'} • ${durationSec}s)`,
          '',
          `*Summary*:`,
          normalized.summary,
        ];

        if (stdoutCollector.truncated || stderrCollector.truncated) {
          lines.push('', '⚠️ _Output exceeded 5MB memory limit and was truncated._');
        }

        if (normalized.filesChanged.length > 0) {
          lines.push('', '*Files Changed*:');
          for (const f of normalized.filesChanged) {
            const diffStr =
              f.additions || f.deletions ? ` (+${f.additions}, -${f.deletions})` : '';
            lines.push(`• \`${f.path}\`${diffStr}`);
          }
        }

        const costStr = normalized.costUsd !== null ? `$${normalized.costUsd.toFixed(2)}` : null;
        const tokensStr =
          normalized.tokensIn !== null && normalized.tokensOut !== null
            ? `${normalized.tokensIn + normalized.tokensOut}`
            : null;

        const statsTokens: string[] = [];
        if (normalized.turnsUsed !== null) statsTokens.push(`Turns: ${normalized.turnsUsed}`);
        if (tokensStr) statsTokens.push(`Tokens: ${tokensStr}`);
        if (costStr) statsTokens.push(`Cost: ${costStr}`);

        if (statsTokens.length > 0) {
          lines.push('', `*Stats*: ${statsTokens.join(' | ')}`);
        }

        lines.push('', `_Next prompt: \`/run <instruction>\` | Raw log: \`/job ${job.id} full\`_`);

        notificationHandler(userId, lines.join('\n'));
      }
    } finally {
      // Guaranteed lock release on every path
      releaseSessionLock(session.id, job.id);
    }
  });

  return job;
}

export async function cancelJob(jobId: number, userId: string): Promise<void> {
  const job = getJobById(jobId);
  if (!job || job.user_id !== userId) {
    throw new NotFoundError('Job', `#${jobId}`);
  }

  if (job.status === 'QUEUED') {
    // If job was queued and not yet running, cancel immediately
    finishJob(job.id, {
      status: 'CANCELLED',
      failureReason: 'USER_CANCEL',
    });
    releaseSessionLock(job.session_id, job.id);
    return;
  }

  if (job.status !== 'RUNNING') {
    throw new InvalidArgumentError(
      `Job #${jobId} is not running (Current status: ${job.status}).`,
      'Only active tasks can be cancelled.'
    );
  }

  // Mark status CANCEL_REQUESTED immediately
  requestJobCancel(jobId);

  const procInfo = activeProcesses.get(jobId);
  if (procInfo && procInfo.child.pid) {
    await terminateProcessGroup(procInfo.child.pid);
  } else if (job.pid) {
    await terminateProcessGroup(job.pid);
  }
}
