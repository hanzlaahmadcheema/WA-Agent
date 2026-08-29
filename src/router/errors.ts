export type ErrorCategory =
  | 'ERR_UNAUTHORIZED'
  | 'ERR_UNKNOWN_COMMAND'
  | 'ERR_MISSING_ARG'
  | 'ERR_INVALID_ARG'
  | 'ERR_SANDBOX_VIOLATION'
  | 'ERR_NOT_FOUND'
  | 'ERR_NO_ACTIVE_SESSION'
  | 'ERR_AGENT_UNAVAILABLE'
  | 'ERR_JOB_COLLISION'
  | 'ERR_SELECTION_EXPIRED'
  | 'ERR_INVALID_CONFIG'
  | 'ERR_RATE_LIMITED';

export class ControlPlaneError extends Error {
  constructor(
    public category: ErrorCategory,
    public reason: string,
    public remediation: string
  ) {
    super(`${category}: ${reason}`);
    this.name = 'ControlPlaneError';
  }

  toWhatsApp(): string {
    return `❌ *${this.category}*: ${this.reason}\n👉 ${this.remediation}`;
  }
}

export class SandboxViolationError extends ControlPlaneError {
  constructor(pathStr: string) {
    super(
      'ERR_SANDBOX_VIOLATION',
      `Path outside sandbox: "${pathStr}"`,
      'Navigation and file access are strictly confined to approved workspace roots.'
    );
  }
}

export class UnauthorizedError extends ControlPlaneError {
  constructor() {
    super(
      'ERR_UNAUTHORIZED',
      'Sender is not authorized to interact with this control plane.',
      'Contact the administrator to whitelist your WhatsApp phone number.'
    );
  }
}

export class NotFoundError extends ControlPlaneError {
  constructor(resource: string, identifier: string, remediation?: string) {
    super(
      'ERR_NOT_FOUND',
      `${resource} "${identifier}" not found.`,
      remediation || `Verify the name or run /ls, /jobs, or /session list.`
    );
  }
}

export class InvalidArgumentError extends ControlPlaneError {
  constructor(reason: string, remediation: string) {
    super('ERR_INVALID_ARG', reason, remediation);
  }
}

export class MissingArgumentError extends ControlPlaneError {
  constructor(argName: string, usage: string) {
    super(
      'ERR_MISSING_ARG',
      `Required argument missing: <${argName}>`,
      `Usage: ${usage}`
    );
  }
}

export class JobCollisionError extends ControlPlaneError {
  constructor(runningJobId: number) {
    super(
      'ERR_JOB_COLLISION',
      `Task #${runningJobId} is currently running in this session.`,
      `Wait for it to finish or run /cancel ${runningJobId} before starting a new task.`
    );
  }
}

export class SelectionExpiredError extends ControlPlaneError {
  constructor() {
    super(
      'ERR_SELECTION_EXPIRED',
      'The selected index is no longer valid.',
      'Directory or list context has changed. Run /ls, /jobs, or /session list to refresh.'
    );
  }
}

export class NoActiveSessionError extends ControlPlaneError {
  constructor() {
    super(
      'ERR_NO_ACTIVE_SESSION',
      'No active session found for this project.',
      'Create one with /session new [name] or view existing ones with /session list.'
    );
  }
}

export class RateLimitedError extends ControlPlaneError {
  constructor(retryAfterSeconds: number = 30) {
    super(
      'ERR_RATE_LIMITED',
      'Too many requests.',
      `Try again in ${retryAfterSeconds} seconds.`
    );
  }
}

