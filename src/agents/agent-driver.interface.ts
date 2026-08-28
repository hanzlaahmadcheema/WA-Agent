import type { ProjectConfig } from '../database/types.js';

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  config: ProjectConfig;
  sessionRef?: string | null;
}

export interface NormalizedAgentResult {
  summary: string;
  filesChanged: Array<{ path: string; additions: number; deletions: number }>;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  turnsUsed: number | null;
  rawOutput: string;
}

export interface AgentDriver {
  name: string;
  binaryName: string;
  buildCommandArgs(options: AgentRunOptions): string[];
  normalizeOutput(stdout: string, stderr: string, exitCode: number | null): NormalizedAgentResult;
}
