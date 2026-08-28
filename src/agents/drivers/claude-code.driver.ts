import type {
  AgentDriver,
  AgentRunOptions,
  NormalizedAgentResult,
} from '../agent-driver.interface.js';
import { config } from '../../config.js';

export class ClaudeCodeDriver implements AgentDriver {
  public readonly name = 'claude';
  public binaryName: string;

  constructor(binaryName: string = config.CLAUDE_BIN_PATH || 'claude') {
    this.binaryName = binaryName;
  }

  buildCommandArgs(options: AgentRunOptions): string[] {
    const args: string[] = [this.binaryName, '-p', options.prompt];

    if (options.config.model) {
      args.push('--model', options.config.model);
    }

    if (options.config.permission_mode) {
      args.push('--permission-mode', options.config.permission_mode);
    }

    if (options.config.max_turns) {
      args.push('--max-turns', String(options.config.max_turns));
    }

    if (options.config.agent_output_format) {
      args.push('--output-format', options.config.agent_output_format);
    }

    if (options.sessionRef) {
      args.push('--resume', options.sessionRef);
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
    let costUsd: number | null = null;
    let turnsUsed: number | null = null;

    const trimmedStdout = stdout.trim();

    // Resilient JSON extraction:
    // Handles pure JSON, JSON inside markdown code blocks, or JSON embedded in surrounding log lines
    let parsed: any = null;
    try {
      if (trimmedStdout.startsWith('{') && trimmedStdout.endsWith('}')) {
        parsed = JSON.parse(trimmedStdout);
      } else {
        // Search for JSON code block ```json ... ```
        const codeMatch = trimmedStdout.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeMatch) {
          parsed = JSON.parse(codeMatch[1].trim());
        } else {
          // Search for outermost curly braces
          const firstBrace = trimmedStdout.indexOf('{');
          const lastBrace = trimmedStdout.lastIndexOf('}');
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            parsed = JSON.parse(trimmedStdout.slice(firstBrace, lastBrace + 1));
          }
        }
      }
    } catch {
      // Malformed JSON: parsed remains null, fallback gracefully without throwing
      parsed = null;
    }

    if (parsed && typeof parsed === 'object') {
      summary =
        parsed.result ||
        parsed.summary ||
        parsed.message ||
        parsed.text ||
        '';

      if (Array.isArray(parsed.files_changed) || Array.isArray(parsed.files)) {
        const list = parsed.files_changed || parsed.files;
        for (const f of list) {
          if (typeof f === 'string') {
            filesChanged.push({ path: f, additions: 0, deletions: 0 });
          } else if (f && typeof f.path === 'string') {
            filesChanged.push({
              path: f.path,
              additions: typeof f.additions === 'number' ? f.additions : 0,
              deletions: typeof f.deletions === 'number' ? f.deletions : 0,
            });
          }
        }
      }

      if (parsed.usage && typeof parsed.usage === 'object') {
        tokensIn = typeof parsed.usage.input_tokens === 'number' ? parsed.usage.input_tokens : null;
        tokensOut = typeof parsed.usage.output_tokens === 'number' ? parsed.usage.output_tokens : null;
      }
      if (typeof parsed.cost === 'number') {
        costUsd = parsed.cost;
      } else if (typeof parsed.total_cost_usd === 'number') {
        costUsd = parsed.total_cost_usd;
      }
      if (typeof parsed.turns === 'number') {
        turnsUsed = parsed.turns;
      }
    }

    // Fallback if no summary extracted or non-JSON output
    if (!summary) {
      if (exitCode === 0) {
        const lines = trimmedStdout.split('\n').filter(Boolean);
        summary = lines.slice(-8).join('\n') || 'Task completed successfully.';
      } else {
        const errLines = stderr.trim().split('\n').filter(Boolean);
        summary =
          errLines.slice(-6).join('\n') ||
          trimmedStdout.slice(-300) ||
          'Task failed with non-zero exit code.';
      }
    }

    return {
      summary,
      filesChanged,
      tokensIn,
      tokensOut,
      costUsd,
      turnsUsed,
      rawOutput: stdout || stderr,
    };
  }
}
