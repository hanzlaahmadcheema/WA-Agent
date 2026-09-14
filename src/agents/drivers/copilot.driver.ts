import type {
  AgentDriver,
  AgentRunOptions,
  NormalizedAgentResult,
} from '../agent-driver.interface.js';
import { config } from '../../config.js';

export interface CopilotDriverOptions {
  binaryPath?: string;
  allowAllTools?: boolean;
}

export class CopilotDriver implements AgentDriver {
  public readonly name = 'copilot';
  public readonly binaryName: string;
  private allowAllTools: boolean;

  constructor(options: CopilotDriverOptions = {}) {
    this.binaryName = options.binaryPath || config.COPILOT_BIN_PATH || 'copilot';
    this.allowAllTools = options.allowAllTools ?? true;
  }

  buildCommandArgs(options: AgentRunOptions): string[] {
    // Official non-interactive JSONL interface: copilot -p <prompt> --output-format=json
    // Never shell interpolation. Safe argv arrays only.
    const args: string[] = [
      this.binaryName,
      '-p',
      options.prompt,
      '--output-format=json',
      '--no-ask-user',
    ];

    if (this.allowAllTools) {
      args.push('--allow-all-tools');
    }

    // Optional model selection.
    // Copilot uses its own model IDs like `claude-haiku-4.5`, `gpt-5-mini`.
    // Agy-style model names like `gemini-3.1-pro-high` are not valid for copilot.
    // Exclude agy-only model patterns: starts with `gemini-`, or `gpt-oss-*`,
    // or any model without a properly versioned suffix (X.Y).
    const isAgyOnlyModel =
      !options.config.model ||
      options.config.model === 'default' ||
      options.config.model === 'claude-3-7-sonnet' ||
      options.config.model.startsWith('gemini-') ||
      options.config.model.startsWith('gpt-oss-') ||
      options.config.model === 'claude-opus-4-6-thinking';
    if (!isAgyOnlyModel) {
      args.push('--model', options.config.model);
    }

    // Session resumption: --resume=<sessionRef>
    if (options.sessionRef) {
      args.push(`--resume=${options.sessionRef}`);
    }

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
    let totalTokens: number | null = null;
    let turnsUsed: number | null = null;
    let conversationId: string | null = null;
    let isSuccess = exitCode === 0;

    const assistantMessages: string[] = [];
    const errorMessages: string[] = [];
    let resultEventFound = false;
    let resultEventExitCode: number | null = null;

    // Copilot --output-format=json outputs JSONL (one JSON object per line)
    const lines = stdout.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || !line.startsWith('{') || !line.endsWith('}')) {
        continue;
      }

      try {
        const event = JSON.parse(line);

        // 1. Session ID extraction
        if (event.sessionId && typeof event.sessionId === 'string') {
          conversationId = event.sessionId;
        } else if (event.data && typeof event.data.sessionId === 'string') {
          conversationId = event.data.sessionId;
        } else if (typeof event.session_id === 'string') {
          conversationId = event.session_id;
        }

        // 2. Turns tracking
        if (event.type === 'assistant.turn_start' || event.type === 'assistant.turn_end') {
          turnsUsed = (turnsUsed || 0) + 1;
        }

        // 3. Assistant message extraction
        if (
          event.type === 'assistant.message' ||
          event.type === 'message' ||
          event.type === 'assistant.response'
        ) {
          const content =
            event.data?.content ||
            event.content ||
            (event.data?.message && event.data.message.content);
          if (typeof content === 'string' && content.trim()) {
            assistantMessages.push(content.trim());
          }
        }

        // 4. Error extraction
        if (event.type === 'session.error' || event.type === 'error' || event.type === 'model.call_failure') {
          const msg =
            event.data?.message ||
            event.data?.errorMessage ||
            event.message ||
            JSON.stringify(event.data || event);
          errorMessages.push(msg);
        }

        // 5. Result event & usage metrics
        if (event.type === 'result') {
          resultEventFound = true;
          if (typeof event.exitCode === 'number') {
            resultEventExitCode = event.exitCode;
          }
          if (typeof event.sessionId === 'string') {
            conversationId = event.sessionId;
          }
          if (event.usage && typeof event.usage === 'object') {
            if (typeof event.usage.inputTokens === 'number') {
              tokensIn = event.usage.inputTokens;
            } else if (typeof event.usage.input_tokens === 'number') {
              tokensIn = event.usage.input_tokens;
            }

            if (typeof event.usage.outputTokens === 'number') {
              tokensOut = event.usage.outputTokens;
            } else if (typeof event.usage.output_tokens === 'number') {
              tokensOut = event.usage.output_tokens;
            }

            if (typeof event.usage.totalTokens === 'number') {
              totalTokens = event.usage.totalTokens;
            } else if (typeof event.usage.total_tokens === 'number') {
              totalTokens = event.usage.total_tokens;
            }

            // File modifications
            if (Array.isArray(event.usage.codeChanges?.filesModified)) {
              for (const file of event.usage.codeChanges.filesModified) {
                if (typeof file === 'string') {
                  filesChanged.push({ path: file, additions: 0, deletions: 0 });
                } else if (file && typeof file.path === 'string') {
                  filesChanged.push({
                    path: file.path,
                    additions: typeof file.linesAdded === 'number' ? file.linesAdded : 0,
                    deletions: typeof file.linesRemoved === 'number' ? file.linesRemoved : 0,
                  });
                }
              }
            }
          }
        }
      } catch {
        // Gracefully ignore individual unparseable lines in stream
      }
    }

    if (totalTokens === null && (tokensIn !== null || tokensOut !== null)) {
      totalTokens = (tokensIn || 0) + (tokensOut || 0);
    }

    // Determine task success vs process exit
    if (resultEventFound || assistantMessages.length > 0 || errorMessages.length > 0) {
      if (exitCode === 0 && (resultEventExitCode === null || resultEventExitCode === 0)) {
        if (errorMessages.length > 0 && assistantMessages.length === 0) {
          isSuccess = false;
          summary = `[COPILOT_ERROR] ${errorMessages.join('\n')}`;
        } else {
          isSuccess = true;
          summary = assistantMessages.join('\n\n') || 'Copilot task completed successfully.';
        }
      } else {
        isSuccess = false;
        summary =
          errorMessages.join('\n') ||
          assistantMessages.join('\n\n') ||
          stderr.trim().slice(-400) ||
          `Copilot task failed with exit code ${exitCode}.`;
      }
    } else {
      // Non-JSON fallback
      isSuccess = exitCode === 0;
      if (exitCode === 0) {
        const cleanLines = stdout.trim().split('\n').filter(Boolean);
        summary = cleanLines.slice(-8).join('\n') || 'Copilot task finished.';
      } else {
        const errLines = stderr.trim().split('\n').filter(Boolean);
        summary =
          errLines.slice(-6).join('\n') ||
          stdout.trim().slice(-300) ||
          `Copilot task failed with exit code ${exitCode}.`;
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
      totalTokens,
    };
  }
}
