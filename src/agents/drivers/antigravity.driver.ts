import type {
  AgentDriver,
  AgentRunOptions,
  NormalizedAgentResult,
} from '../agent-driver.interface.js';
import { config } from '../../config.js';

export interface AntigravityDriverOptions {
  binaryPath?: string;
  jsonSchema?: string | object;
  effort?: 'low' | 'medium' | 'high';
}

export class AntigravityDriver implements AgentDriver {
  public readonly name = 'antigravity';
  public readonly binaryName: string;
  private defaultJsonSchema?: string;
  private defaultEffort?: 'low' | 'medium' | 'high';

  constructor(options: AntigravityDriverOptions = {}) {
    this.binaryName = options.binaryPath || config.ANTIGRAVITY_BIN_PATH || 'agy';
    if (options.jsonSchema) {
      this.defaultJsonSchema =
        typeof options.jsonSchema === 'string'
          ? options.jsonSchema
          : JSON.stringify(options.jsonSchema);
    }
    this.defaultEffort = options.effort;
  }

  buildCommandArgs(options: AgentRunOptions): string[] {
    // Safe argv arrays only. No shell interpolation.
    const args: string[] = [this.binaryName, '-p', options.prompt, '--output-format', 'json'];

    // Optional model selection
    if (options.config.model && options.config.model !== 'default' && options.config.model !== 'claude-3-7-sonnet') {
      args.push('--model', options.config.model);
    }

    // Session resume via conversation ID
    if (options.sessionRef) {
      args.push('--conversation', options.sessionRef);
    }

    // Structured output schema
    if (this.defaultJsonSchema) {
      args.push('--json-schema', this.defaultJsonSchema);
    }

    // Reasoning effort
    if (this.defaultEffort) {
      args.push('--effort', this.defaultEffort);
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
    let thinkingTokens: number | null = null;
    let cacheReadTokens: number | null = null;
    let totalTokens: number | null = null;
    let turnsUsed: number | null = null;
    let conversationId: string | null = null;
    let structuredOutput: any = undefined;
    let isSuccess = false;

    const trimmedStdout = stdout.trim();
    let parsed: any = null;

    try {
      if (trimmedStdout.startsWith('{') && trimmedStdout.endsWith('}')) {
        parsed = JSON.parse(trimmedStdout);
      } else {
        // Handle markdown code blocks or embedded JSON
        const codeMatch = trimmedStdout.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeMatch) {
          parsed = JSON.parse(codeMatch[1].trim());
        } else {
          const firstBrace = trimmedStdout.indexOf('{');
          const lastBrace = trimmedStdout.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            parsed = JSON.parse(trimmedStdout.slice(firstBrace, lastBrace + 1));
          }
        }
      }
    } catch {
      parsed = null;
    }

    if (parsed && typeof parsed === 'object') {
      conversationId = typeof parsed.conversation_id === 'string' ? parsed.conversation_id : null;
      turnsUsed = typeof parsed.num_turns === 'number' ? parsed.num_turns : null;

      // Extract input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens
      if (parsed.usage && typeof parsed.usage === 'object') {
        tokensIn = typeof parsed.usage.input_tokens === 'number' ? parsed.usage.input_tokens : null;
        tokensOut = typeof parsed.usage.output_tokens === 'number' ? parsed.usage.output_tokens : null;
        thinkingTokens = typeof parsed.usage.thinking_tokens === 'number' ? parsed.usage.thinking_tokens : null;
        cacheReadTokens = typeof parsed.usage.cache_read_tokens === 'number' ? parsed.usage.cache_read_tokens : null;
        totalTokens = typeof parsed.usage.total_tokens === 'number' ? parsed.usage.total_tokens : null;
      }

      // Structured output extraction
      if (parsed.structured_output !== undefined) {
        structuredOutput = parsed.structured_output;
      }

      const status = typeof parsed.status === 'string' ? parsed.status.toUpperCase() : '';
      const responseText = typeof parsed.response === 'string' ? parsed.response.trim() : '';

      // Critical Rule: Never treat exit code 0 alone as success. Validate Antigravity's result status.
      if (exitCode === 0 && status === 'SUCCESS') {
        isSuccess = true;
        summary = responseText || 'Task completed successfully.';
      } else {
        isSuccess = false;
        const failureStatus = status || (exitCode !== 0 ? `EXIT_CODE_${exitCode}` : 'UNKNOWN_FAILURE');
        summary = responseText
          ? `[${failureStatus}] ${responseText}`
          : `Task failed with status: ${failureStatus}`;
      }
    } else {
      // Malformed or unexpected non-JSON output fallback
      isSuccess = false;
      if (exitCode === 0) {
        const lines = trimmedStdout.split('\n').filter(Boolean);
        summary = lines.slice(-8).join('\n') || 'Task produced unexpected non-JSON output.';
      } else {
        const errLines = stderr.trim().split('\n').filter(Boolean);
        summary =
          errLines.slice(-6).join('\n') ||
          trimmedStdout.slice(-300) ||
          'Task failed with non-zero exit code and non-JSON output.';
      }
    }

    return {
      summary,
      filesChanged,
      tokensIn,
      tokensOut,
      costUsd: null, // cost_usd strictly remains null
      turnsUsed,
      rawOutput: stdout || stderr,
      isSuccess,
      conversationId,
      thinkingTokens,
      cacheReadTokens,
      totalTokens,
      structuredOutput,
    };
  }
}
