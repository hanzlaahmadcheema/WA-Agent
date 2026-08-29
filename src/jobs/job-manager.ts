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
import { updateSessionMetrics, updateSessionAgentRef } from '../database/repositories/session.repo.js';
import { acquireSessionLock, releaseSessionLock } from '../state/session-lock.js';
import { getAgentDriver } from '../agents/agent-registry.js';
import { spawnDetachedAgent, terminateProcessGroup } from './process-supervisor.js';
import { StreamCollector } from './stream-collector.js';
import { LIMITS } from '../security/limits.js';
import { createCorrelationLogger, sanitizePromptForLog } from '../logger.js';
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
  timeoutTimer: NodeJS.Timeout;
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

  const jobLogger = createCorrelationLogger({
    userId,
    projectId: project.id,
    sessionId: session.id,
    jobId: job.id,
  });

  jobLogger.info(
    { prompt: sanitizePromptForLog(prompt), agent: project.selected_agent },
    'job.created'
  );

  try {
    acquireSessionLock(session.id, job.id);
  } catch (err) {
    finishJob(job.id, {
      status: 'FAILED',
      failureReason: 'PROCESS_ERROR',
      errorMessage: 'Session lock acquisition collision.',
    });
    jobLogger.warn({ error: (err as any).message }, 'job.collision');
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
    jobLogger.error({ error: err.message }, 'job.failed_spawn');
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

    jobLogger.error({ error: err.message }, 'job.error');

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
    jobLogger.error('job.missing_pid');
    throw new InvalidArgumentError(
      `Agent binary "${commandArgs[0]}" could not be launched.`,
      'Verify that the CLI binary is installed and executable on the host.'
    );
  }

  updateJobRunning(job.id, pid);
  jobLogger.info({ pid }, 'job.started');

  const stdoutCollector = new StreamCollector();
  const stderrCollector = new StreamCollector();

  // Enforce maximum execution runtime watchdog
  const timeoutTimer = setTimeout(async () => {
    jobLogger.warn({ maxRuntimeMs: LIMITS.MAX_JOB_RUNTIME_MS }, 'job.timeout');
    try {
      await cancelJob(job.id, userId);
      finishJob(job.id, {
        status: 'TIMED_OUT',
        failureReason: 'TIMEOUT',
        errorMessage: `Task exceeded maximum runtime limit of ${Math.round(LIMITS.MAX_JOB_RUNTIME_MS / 60000)} minutes.`,
      });
      if (notificationHandler) {
        notificationHandler(
          userId,
          `⏱️ *Job #${job.id} Timed Out*\nTask exceeded maximum execution limit (${Math.round(LIMITS.MAX_JOB_RUNTIME_MS / 60000)}m).`
        );
      }
    } catch {}
  }, LIMITS.MAX_JOB_RUNTIME_MS);
  timeoutTimer.unref();

  activeProcesses.set(job.id, {
    child,
    sessionId: session.id,
    userId,
    stdoutCollector,
    stderrCollector,
    timeoutTimer,
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutCollector.write(chunk);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrCollector.write(chunk);
  });

  child.on('close', (exitCode) => {
    clearTimeout(timeoutTimer);
    activeProcesses.delete(job.id);

    try {
      const latestJob = getJobById(job.id);
      const wasCancelledOrRequested =
        latestJob?.status === 'CANCEL_REQUESTED' || latestJob?.status === 'CANCELLED';

      const stdout = stdoutCollector.getString();
      const stderr = stderrCollector.getString();
      saveJobOutput(job.id, stdout, stderr);

      if (wasCancelledOrRequested) {
        finishJob(job.id, {
          status: 'CANCELLED',
          exitCode,
          failureReason: 'USER_CANCEL',
          stdoutBytes: stdoutCollector.totalBytes,
          stderrBytes: stderrCollector.totalBytes,
          stdoutTruncated: stdoutCollector.truncated,
          stderrTruncated: stderrCollector.truncated,
        });

        jobLogger.info({ exitCode }, 'job.cancelled');

        if (notificationHandler && latestJob?.status === 'CANCEL_REQUESTED') {
          notificationHandler(
            userId,
            `🛑 *Job #${job.id} Cancelled*\nProcess terminated.`
          );
        }
        return;
      }

      const normalized = driver.normalizeOutput(stdout, stderr, exitCode);
      const isSuccess = exitCode === 0 && normalized.isSuccess !== false;

      // Update session's agent reference if the agent returns one (e.g. Antigravity conversation_id)
      if (normalized.conversationId && session.agent_session_ref !== normalized.conversationId) {
        updateSessionAgentRef(session.id, normalized.conversationId);
        session.agent_session_ref = normalized.conversationId;
      }

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

      if (isSuccess) {
        jobLogger.info(
          { exitCode, durationMs: finished.duration_ms, costUsd: normalized.costUsd },
          'job.completed'
        );
      } else {
        jobLogger.warn(
          { exitCode, durationMs: finished.duration_ms, error: normalized.summary },
          'job.failed'
        );
      }

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

/**
 * Gracefully terminates all active process groups on daemon shutdown.
 */
export async function shutdownAllJobs(timeoutMs = 3000): Promise<void> {
  const activeIds = Array.from(activeProcesses.keys());
  if (activeIds.length === 0) return;

  const killPromises = activeIds.map(async (jobId) => {
    const procInfo = activeProcesses.get(jobId);
    if (!procInfo) return;

    clearTimeout(procInfo.timeoutTimer);
    const pid = procInfo.child.pid;

    finishJob(jobId, {
      status: 'CANCELLED',
      failureReason: 'USER_CANCEL',
      errorMessage: 'Task gracefully terminated during server shutdown.',
    });

    releaseSessionLock(procInfo.sessionId, jobId);

    if (pid) {
      await terminateProcessGroup(pid, timeoutMs);
    }
  });

  await Promise.all(killPromises);
  activeProcesses.clear();
}
