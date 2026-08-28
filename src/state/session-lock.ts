import { JobCollisionError } from '../router/errors.js';

// Map of sessionId -> jobId currently running
const sessionLocks = new Map<string, number>();

export function acquireSessionLock(sessionId: string, jobId: number): void {
  const existingJobId = sessionLocks.get(sessionId);
  if (existingJobId !== undefined && existingJobId !== jobId) {
    throw new JobCollisionError(existingJobId);
  }
  sessionLocks.set(sessionId, jobId);
}

export function releaseSessionLock(sessionId: string, jobId?: number): void {
  if (jobId !== undefined) {
    const current = sessionLocks.get(sessionId);
    if (current === jobId) {
      sessionLocks.delete(sessionId);
    }
  } else {
    sessionLocks.delete(sessionId);
  }
}

export function getActiveJobForSession(sessionId: string): number | undefined {
  return sessionLocks.get(sessionId);
}

export function isSessionLocked(sessionId: string): boolean {
  return sessionLocks.has(sessionId);
}
