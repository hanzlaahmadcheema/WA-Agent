import { getDatabase } from '../connection.js';
import type { Job, JobOutput, JobFailureReason } from '../types.js';

export interface CreateJobParams {
  sessionId: string;
  projectId: string;
  userId: string;
  prompt: string;
  commandArgs: string[]; // will be serialized to JSON
}

export interface FinishJobParams {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  exitCode?: number | null;
  failureReason?: JobFailureReason | null;
  errorMessage?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  turnsUsed?: number | null;
  summary?: string | null;
  filesChanged?: Array<{ path: string; additions: number; deletions: number }> | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export function createJob(params: CreateJobParams): Job {
  const db = getDatabase();
  const now = Date.now();

  const info = db
    .prepare(`
      INSERT INTO jobs (
        session_id, project_id, user_id, prompt, command_args,
        status, pid, exit_code, failure_reason, error_message,
        created_at, started_at, finished_at, duration_ms,
        tokens_in, tokens_out, cost_usd, turns_used,
        summary, files_changed, stdout_bytes, stderr_bytes,
        stdout_truncated, stderr_truncated
      ) VALUES (
        ?, ?, ?, ?, ?,
        'QUEUED', NULL, NULL, NULL, NULL,
        ?, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        NULL, NULL, 0, 0,
        0, 0
      )
    `)
    .run(
      params.sessionId,
      params.projectId,
      params.userId,
      params.prompt,
      JSON.stringify(params.commandArgs),
      now
    );

  const jobId = Number(info.lastInsertRowid);
  return getJobById(jobId)!;
}

export function updateJobRunning(jobId: number, pid: number): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(`
    UPDATE jobs
    SET status = 'RUNNING', pid = ?, started_at = ?
    WHERE id = ?
  `).run(pid, now, jobId);
}

export function requestJobCancel(jobId: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE jobs
    SET status = 'CANCEL_REQUESTED'
    WHERE id = ? AND status = 'RUNNING'
  `).run(jobId);
}

export function finishJob(jobId: number, params: FinishJobParams): Job {
  const db = getDatabase();
  const job = getJobById(jobId);
  const now = Date.now();
  const startedAt = job?.started_at || job?.created_at || now;
  const durationMs = now - startedAt;

  db.prepare(`
    UPDATE jobs
    SET status = ?,
        exit_code = ?,
        failure_reason = ?,
        error_message = ?,
        finished_at = ?,
        duration_ms = ?,
        tokens_in = ?,
        tokens_out = ?,
        cost_usd = ?,
        turns_used = ?,
        summary = ?,
        files_changed = ?,
        stdout_bytes = COALESCE(?, stdout_bytes),
        stderr_bytes = COALESCE(?, stderr_bytes),
        stdout_truncated = COALESCE(?, stdout_truncated),
        stderr_truncated = COALESCE(?, stderr_truncated)
    WHERE id = ?
  `).run(
    params.status,
    params.exitCode !== undefined ? params.exitCode : null,
    params.failureReason || null,
    params.errorMessage || null,
    now,
    durationMs,
    params.tokensIn ?? null,
    params.tokensOut ?? null,
    params.costUsd ?? null,
    params.turnsUsed ?? null,
    params.summary || null,
    params.filesChanged ? JSON.stringify(params.filesChanged) : null,
    params.stdoutBytes ?? null,
    params.stderrBytes ?? null,
    params.stdoutTruncated ? 1 : 0,
    params.stderrTruncated ? 1 : 0,
    jobId
  );

  return getJobById(jobId)!;
}

export function getJobById(jobId: number): Job | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as unknown as Job | undefined;
}

export function getRecentJobs(userId: string, limit: number = 10): Job[] {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit) as unknown as Job[];
}

export function saveJobOutput(
  jobId: number,
  stdout: string | null,
  stderr: string | null,
  rawPath: string | null = null
): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(`
    INSERT INTO job_outputs (job_id, stdout, stderr, raw_output_path, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      stdout = excluded.stdout,
      stderr = excluded.stderr,
      raw_output_path = excluded.raw_output_path
  `).run(jobId, stdout, stderr, rawPath, now);
}

export function getJobOutput(jobId: number): JobOutput | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM job_outputs WHERE job_id = ?').get(jobId) as unknown as
    | JobOutput
    | undefined;
}
