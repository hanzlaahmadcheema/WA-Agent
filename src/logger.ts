import pino from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level: LOG_LEVEL,
  redact: {
    paths: [
      'password',
      '*.password',
      'secret',
      '*.secret',
      'token',
      '*.token',
      'auth',
      '*.auth',
      'key',
      '*.key',
      'creds',
      '*.creds',
      'authorization',
      '*.authorization',
    ],
    censor: '[REDACTED]',
  },
  base: {
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export interface LogCorrelationContext {
  requestId?: string;
  messageId?: string;
  userId?: string;
  projectId?: string;
  sessionId?: string;
  jobId?: number;
}

export function createCorrelationLogger(context: LogCorrelationContext) {
  return logger.child(context);
}

/**
 * Truncates user prompts in logs to prevent log pollution and accidental data leakage.
 */
export function sanitizePromptForLog(prompt: string, maxLen: number = 80): string {
  const trimmed = prompt.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen) + `... [truncated ${trimmed.length - maxLen} chars]`;
}
