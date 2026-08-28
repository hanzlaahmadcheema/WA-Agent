export type ConnectionState = 'OPEN' | 'CLOSED' | 'RECONNECTING' | 'LOGGED_OUT';

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
  jitterFactor: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseMs: 1000,     // 1s initial
  maxMs: 30000,     // 30s cap
  jitterFactor: 0.25, // ±25% random jitter to avoid storms
};

export function calculateBackoffWithJitter(
  attempt: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG
): number {
  const exponential = Math.min(
    config.maxMs,
    config.baseMs * Math.pow(2, Math.max(0, attempt))
  );
  // Random jitter between -jitterFactor and +jitterFactor
  const jitterOffset = exponential * config.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(config.baseMs, Math.round(exponential + jitterOffset));
}

export class ConnectionFSM {
  private state: ConnectionState = 'CLOSED';
  private attemptCount = 0;

  constructor(private config: BackoffConfig = DEFAULT_BACKOFF_CONFIG) {}

  getState(): ConnectionState {
    return this.state;
  }

  getAttempts(): number {
    return this.attemptCount;
  }

  onConnecting(): void {
    if (this.state !== 'RECONNECTING') {
      this.state = 'RECONNECTING';
    }
  }

  onOpen(): void {
    this.state = 'OPEN';
    this.attemptCount = 0;
  }

  onClose(statusCode?: number): {
    nextState: ConnectionState;
    delayMs?: number;
    isLoggedOut: boolean;
  } {
    // 401: Unauthorized / Logged out from WhatsApp
    // 403: Forbidden
    const isLoggedOut = statusCode === 401 || statusCode === 403;

    if (isLoggedOut) {
      this.state = 'LOGGED_OUT';
      this.attemptCount = 0;
      return { nextState: 'LOGGED_OUT', isLoggedOut: true };
    }

    this.state = 'RECONNECTING';
    const delayMs = calculateBackoffWithJitter(this.attemptCount, this.config);
    this.attemptCount++;

    return {
      nextState: 'RECONNECTING',
      delayMs,
      isLoggedOut: false,
    };
  }

  onManualClose(): void {
    this.state = 'CLOSED';
    this.attemptCount = 0;
  }

  reset(): void {
    this.state = 'CLOSED';
    this.attemptCount = 0;
  }
}
