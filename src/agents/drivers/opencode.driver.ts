import type {
  AgentDriver,
  AgentRunOptions,
  NormalizedAgentResult,
} from '../agent-driver.interface.js';
import { config } from '../../config.js';

export interface OpenCodeDriverOptions {
  binaryPath?: string;
  agent?: string;
  variant?: string;
}

export class OpenCodeDriver implements AgentDriver {
  public readonly name = 'opencode';
  public readonly binaryName: string;
  private defaultAgent?: string;
  private defaultVariant?: string;

  constructor(options: OpenCodeDriverOptions = {}) {
    this.binaryName = options.binaryPath || config.OPENCODE_BIN_PATH || 'opencode';
    this.defaultAgent = options.agent;
    this.defaultVariant = options.variant;
  }

  buildCommandArgs(options: AgentRunOptions): string[] {
    // Safe argv construction. No shell interpolation.
    const args: string[] = [this.binaryName, 'run'];

    // Working directory
    args.push('--dir', options.cwd);

    // Stream format
    args.push('--format', 'json');

    // Auto mode for non-interactive execution
    args.push('--auto');

    // Optional model selection
    if (
      options.config.model &&
      options.config.model !== 'default' &&
      options.config.model !== 'claude-3-7-sonnet'
    ) {
      args.push('--model', options.config.model);
    }

    // Optional agent selection
    if (this.defaultAgent) {
      args.push('--agent', this.defaultAgent);
    }

    // Optional variant
    if (this.defaultVariant) {
      args.push('--variant', this.defaultVariant);
    }

    // Session resumption: --session <sessionID>
    if (options.sessionRef) {
      args.push('--session', options.sessionRef);
    }

    // Prompt is passed as safe single literal argument
    args.push(options.prompt);
    return args;
  }

  normalizeOutput(
    stdout: string,
    stderr: string,
    exitCode: number | null
  ): NormalizedAgentResult {
    let summary = '';
    const filesChanged: Array<{ path: string; additions: number; deletions: number }> = [];
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let costUsd: number | null = null;
    let turnsUsed: number | null = null;
    let conversationId: string | null = null;
    let isSuccess = false;

    const assistantTexts: string[] = [];
    const errorMessages: string[] = [];
    let parsedAnyEvent = false;

    // OpenCode --format json emits NDJSON (one event per line)
    const lines = stdout.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('{') || !line.endsWith('}')) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        parsedAnyEvent = true;

        // 1. Session ID extraction
        if (typeof event.sessionID === 'string') {
          conversationId = event.sessionID;
        } else if (typeof event.sessionId === 'string') {
          conversationId = event.sessionId;
        } else if (typeof event.session_id === 'string') {
          conversationId = event.session_id;
        } else if (event.session && typeof event.session.id === 'string') {
          conversationId = event.session.id;
        }

        // 2. Assistant text extraction
        if (event.type === 'text' && event.part && typeof event.part.text === 'string') {
          if (event.part.text.trim()) assistantTexts.push(event.part.text.trim());
        } else if (event.type === 'assistant' && typeof event.text === 'string') {
          if (event.text.trim()) assistantTexts.push(event.text.trim());
        } else if (event.type === 'message' && event.message && typeof event.message.content === 'string') {
          if (event.message.content.trim()) assistantTexts.push(event.message.content.trim());
        } else if (typeof event.content === 'string' && event.type !== 'error') {
          if (event.content.trim()) assistantTexts.push(event.content.trim());
        }

        // 3. Error extraction
        if (event.type === 'error') {
          const msg =
            typeof event.message === 'string'
              ? event.message
              : typeof event.error?.message === 'string'
                ? event.error.message
                : JSON.stringify(event.error || event);
          errorMessages.push(msg);
        }

        // 4. step_finish extraction: tokens and cost
        if (event.type === 'step_finish' || event.step_finish) {
          turnsUsed = (turnsUsed || 0) + 1;
          const step = event.step_finish || event;

          // Tokens extraction
          const tokensObj = step.tokens || step.usage;
          if (tokensObj && typeof tokensObj === 'object') {
            const inTok =
              typeof tokensObj.input === 'number'
                ? tokensObj.input
                : typeof tokensObj.input_tokens === 'number'
                  ? tokensObj.input_tokens
                  : null;
            const outTok =
              typeof tokensObj.output === 'number'
                ? tokensObj.output
                : typeof tokensObj.output_tokens === 'number'
                  ? tokensObj.output_tokens
                  : null;

            if (inTok !== null) tokensIn = (tokensIn || 0) + inTok;
            if (outTok !== null) tokensOut = (tokensOut || 0) + outTok;
          }

          // Cost extraction
          if (typeof step.cost === 'number') {
            costUsd = (costUsd || 0) + step.cost;
          }
        }
      } catch {
        // Gracefully ignore individual malformed lines in JSON stream
      }
    }

    const totalTokens = tokensIn !== null || tokensOut !== null ? (tokensIn || 0) + (tokensOut || 0) : null;

    // Critical Rule: Do not treat exit code 0 alone as success.
    // Important OpenCode rule: JSON output may occasionally omit final step_finish events.
    // The driver must remain successful if the task completed and usable assistant output exists,
    // while leaving unavailable token/cost metrics as null.
    if (exitCode === 0) {
      if (errorMessages.length > 0 && assistantTexts.length === 0) {
        isSuccess = false;
        summary = `[OPENCODE_ERROR] ${errorMessages.join('\n')}`;
      } else if (assistantTexts.length > 0) {
        isSuccess = true;
        summary = assistantTexts.join('\n\n');
      } else if (parsedAnyEvent) {
        isSuccess = true;
        summary = 'OpenCode task completed.';
      } else {
        // Raw stdout fallback
        const cleanLines = stdout.trim().split('\n').filter(Boolean);
        if (cleanLines.length > 0) {
          isSuccess = true;
          summary = cleanLines.slice(-8).join('\n');
        } else {
          isSuccess = false;
          summary = 'OpenCode produced no output.';
        }
      }
    } else {
      isSuccess = false;
      summary =
        errorMessages.join('\n') ||
        assistantTexts.join('\n\n') ||
        stderr.trim().slice(-400) ||
        `OpenCode task failed with exit code ${exitCode}.`;
    }

    return {
      summary,
      filesChanged,
      tokensIn,
      tokensOut,
      costUsd,
      turnsUsed,
      rawOutput: stdout || stderr,
      isSuccess,
      conversationId,
      totalTokens,
    };
  }
}
