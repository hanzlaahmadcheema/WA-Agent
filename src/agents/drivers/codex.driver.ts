import type {
  AgentDriver,
  AgentRunOptions,
  NormalizedAgentResult,
} from '../agent-driver.interface.js';
import { config } from '../../config.js';

export interface CodexDriverOptions {
  binaryPath?: string;
  outputSchemaPath?: string;
  additionalDirs?: string[];
}

export class CodexDriver implements AgentDriver {
  public readonly name = 'codex';
  public readonly binaryName: string;
  private defaultOutputSchema?: string;
  private additionalDirs?: string[];

  constructor(options: CodexDriverOptions = {}) {
    this.binaryName = options.binaryPath || config.CODEX_BIN_PATH || 'codex';
    this.defaultOutputSchema = options.outputSchemaPath;
    this.additionalDirs = options.additionalDirs;
  }

  buildCommandArgs(options: AgentRunOptions): string[] {
    // Safe argv construction. Never shell interpolation.
    if (options.sessionRef) {
      // Resumed session: codex exec resume <SESSION_ID> <prompt>
      const args: string[] = [
        this.binaryName,
        'exec',
        'resume',
        options.sessionRef,
        options.prompt,
        '--json',
        '--skip-git-repo-check',
      ];

      if (
        options.config.model &&
        options.config.model !== 'default' &&
        options.config.model !== 'claude-3-7-sonnet'
      ) {
        args.push('-m', options.config.model);
      }

      if (this.defaultOutputSchema) {
        args.push('--output-schema', this.defaultOutputSchema);
      }

      return args;
    }

    // New task: codex exec -C <cwd> [options] <prompt>
    const args: string[] = [
      this.binaryName,
      'exec',
      '-C',
      options.cwd,
      '--json',
      '--skip-git-repo-check',
    ];

    if (
      options.config.model &&
      options.config.model !== 'default' &&
      options.config.model !== 'claude-3-7-sonnet'
    ) {
      args.push('-m', options.config.model);
    }

    if (this.defaultOutputSchema) {
      args.push('--output-schema', this.defaultOutputSchema);
    }

    if (this.additionalDirs && this.additionalDirs.length > 0) {
      for (const dir of this.additionalDirs) {
        args.push('--add-dir', dir);
      }
    }

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
    let cacheReadTokens: number | null = null;
    let totalTokens: number | null = null;
    let turnsUsed: number | null = null;
    let conversationId: string | null = null;
    let structuredOutput: any = undefined;
    let isSuccess = exitCode === 0;

    const agentResponses: string[] = [];
    const errorMessages: string[] = [];
    let parsedAnyEvent = false;

    // Codex --json emits NDJSON (one event per line)
    const lines = stdout.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('{') || !line.endsWith('}')) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        parsedAnyEvent = true;

        // 1. Thread/Session ID extraction
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          conversationId = event.thread_id;
        } else if (event.type === 'session.started' && typeof event.session_id === 'string') {
          conversationId = event.session_id;
        } else if (typeof event.conversation_id === 'string') {
          conversationId = event.conversation_id;
        }

        // 2. Turns tracking
        if (event.type === 'turn.started' || event.type === 'turn.completed') {
          turnsUsed = (turnsUsed || 0) + 1;
        }

        // 3. Token usage extraction
        if (event.usage && typeof event.usage === 'object') {
          if (typeof event.usage.input_tokens === 'number') {
            tokensIn = (tokensIn || 0) + event.usage.input_tokens;
          }
          if (typeof event.usage.output_tokens === 'number') {
            tokensOut = (tokensOut || 0) + event.usage.output_tokens;
          }
          if (typeof event.usage.cached_input_tokens === 'number') {
            cacheReadTokens = (cacheReadTokens || 0) + event.usage.cached_input_tokens;
          } else if (typeof event.usage.cache_read_tokens === 'number') {
            cacheReadTokens = (cacheReadTokens || 0) + event.usage.cache_read_tokens;
          }
        }

        // 4. Item / Message / Error processing
        if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
          const item = event.item;
          if (item.type === 'agent_message' || item.type === 'message') {
            if (typeof item.text === 'string' && item.text.trim()) {
              agentResponses.push(item.text.trim());
            } else if (Array.isArray(item.content)) {
              const textParts = item.content
                .filter((c: any) => c && typeof c.text === 'string')
                .map((c: any) => c.text);
              if (textParts.length > 0) {
                agentResponses.push(textParts.join('\n').trim());
              }
            }
          } else if (item.type === 'error') {
            const msg = typeof item.message === 'string' ? item.message : JSON.stringify(item);
            errorMessages.push(msg);
          } else if (item.type === 'file_change' && typeof item.path === 'string') {
            filesChanged.push({
              path: item.path,
              additions: typeof item.additions === 'number' ? item.additions : 0,
              deletions: typeof item.deletions === 'number' ? item.deletions : 0,
            });
          }
        } else if (event.type === 'error' && typeof event.message === 'string') {
          errorMessages.push(event.message);
        }

        // 5. Structured output extraction
        if (event.structured_output !== undefined) {
          structuredOutput = event.structured_output;
        }
      } catch {
        // Ignore JSON parse errors on individual lines
      }
    }

    if (tokensIn !== null || tokensOut !== null) {
      totalTokens = (tokensIn || 0) + (tokensOut || 0);
    }

    // Determine final task success vs process exit
    if (parsedAnyEvent) {
      if (exitCode === 0) {
        if (errorMessages.length > 0 && agentResponses.length === 0) {
          // Soft failure: exit 0 but fatal error event recorded with no message
          isSuccess = false;
          summary = `[CODEX_ERROR] ${errorMessages.join('\n')}`;
        } else {
          isSuccess = true;
          summary = agentResponses.join('\n\n') || 'Task completed successfully.';
        }
      } else {
        isSuccess = false;
        summary =
          errorMessages.join('\n') ||
          agentResponses.join('\n\n') ||
          stderr.trim().slice(-400) ||
          'Codex process exited with failure code.';
      }
    } else {
      // Fallback for non-JSON or unexpected raw output
      isSuccess = exitCode === 0;
      if (exitCode === 0) {
        const cleanLines = stdout.trim().split('\n').filter(Boolean);
        summary = cleanLines.slice(-8).join('\n') || 'Task completed with output.';
      } else {
        const errLines = stderr.trim().split('\n').filter(Boolean);
        summary =
          errLines.slice(-6).join('\n') ||
          stdout.trim().slice(-300) ||
          `Codex task failed with exit code ${exitCode}.`;
      }
    }

    // Try parsing structured output from the last agent response if configured
    if (structuredOutput === undefined && agentResponses.length > 0 && this.defaultOutputSchema) {
      const lastText = agentResponses[agentResponses.length - 1];
      try {
        structuredOutput = JSON.parse(lastText);
      } catch {
        const match = lastText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (match) {
          try {
            structuredOutput = JSON.parse(match[1]);
          } catch {}
        }
      }
    }

    return {
      summary,
      filesChanged,
      tokensIn,
      tokensOut,
      costUsd: null, // Cost strictly remains null
      turnsUsed,
      rawOutput: stdout || stderr,
      isSuccess,
      conversationId,
      cacheReadTokens,
      totalTokens,
      structuredOutput,
    };
  }
}
