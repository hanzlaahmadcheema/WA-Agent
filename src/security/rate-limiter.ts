import { LIMITS } from './limits.js';
import { RateLimitedError } from '../router/errors.js';

export type RateLimitAction = 'inbound' | 'run' | 'filesystem';

interface ActionRecord {
  timestamps: number[];
}

// Map: userId -> action -> timestamps
const userBuckets = new Map<string, Map<RateLimitAction, ActionRecord>>();

const WINDOW_MS = 60 * 1000; // 1 minute sliding window

function getLimitForAction(action: RateLimitAction): number {
  switch (action) {
    case 'inbound':
      return LIMITS.RATE_LIMITS.INBOUND_MESSAGES_PER_MIN;
    case 'run':
      return LIMITS.RATE_LIMITS.RUN_PER_MIN;
    case 'filesystem':
      return LIMITS.RATE_LIMITS.FILESYSTEM_PER_MIN;
  }
}

/**
 * Checks and increments rate limit for a user action using sliding window.
 * Throws RateLimitedError if threshold is reached.
 */
export function checkAndRecordRateLimit(userId: string, action: RateLimitAction): void {
  const now = Date.now();
  const maxAllowed = getLimitForAction(action);

  let userMap = userBuckets.get(userId);
  if (!userMap) {
    userMap = new Map<RateLimitAction, ActionRecord>();
    userBuckets.set(userId, userMap);
  }

  let record = userMap.get(action);
  if (!record) {
    record = { timestamps: [] };
    userMap.set(action, record);
  }

  // Filter out timestamps older than 60s
  record.timestamps = record.timestamps.filter((ts) => now - ts < WINDOW_MS);

  if (record.timestamps.length >= maxAllowed) {
    const oldest = record.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    throw new RateLimitedError(retryAfterSec);
  }

  // Record this action
  record.timestamps.push(now);
}

export function resetRateLimits(userId?: string): void {
  if (userId) {
    userBuckets.delete(userId);
  } else {
    userBuckets.clear();
  }
}
