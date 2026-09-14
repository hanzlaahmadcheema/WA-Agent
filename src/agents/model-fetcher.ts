import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export interface AvailableModel {
  id: string;
  label: string;
}

// Fallback / standard models for each agent when dynamic CLI fetch is unavailable
const DEFAULT_MODELS_BY_AGENT: Record<string, AvailableModel[]> = {
  claude: [
    { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet (Hybrid Reasoning)' },
    { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet (Balanced)' },
    { id: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku (Fast & Lightweight)' },
    { id: 'claude-3-opus', label: 'Claude 3 Opus (High Intelligence)' },
  ],
  antigravity: [
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
    { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
  opencode: [
    { id: 'opencode/big-pickle', label: 'Big Pickle' },
    { id: 'opencode/ling-3.0-flash-fin-free', label: 'Ling 3.0 Flash (Free)' },
    { id: 'opencode/mimo-v2.5-free', label: 'Mimo v2.5 (Free)' },
    { id: 'opencode/muse-spark-1.3-contributor-free', label: 'Muse Spark 1.3 (Free)' },
    { id: 'opencode/nemotron-3.5-lightning-free', label: 'Nemotron 3.5 Lightning (Free)' },
  ],
  codex: [
    { id: 'o3-mini', label: 'OpenAI o3-mini (Reasoning)' },
    { id: 'o3', label: 'OpenAI o3' },
    { id: 'o1', label: 'OpenAI o1' },
    { id: 'gpt-4o', label: 'GPT-4o (Omni)' },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
  ],
  copilot: [
    { id: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
    { id: 'claude-3.5-sonnet', label: 'Claude 3.5 Sonnet' },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
};

/**
 * Fetches available models for the given agent.
 * Tries dynamic CLI query first, then falls back to built-in curated models.
 */
export async function fetchModelsForAgent(agentName: string): Promise<AvailableModel[]> {
  const norm = (agentName || 'claude').toLowerCase();

  // 1. Try dynamic query for Antigravity
  if (norm === 'antigravity') {
    try {
      const bin = config.ANTIGRAVITY_BIN_PATH || 'agy';
      const { stdout } = await execFileAsync(bin, ['models'], { timeout: 5000 });
      const parsed = parseAntigravityModels(stdout);
      if (parsed.length > 0) return parsed;
    } catch {
      // Fallback
    }
  }

  // 2. Try dynamic query for OpenCode
  if (norm === 'opencode') {
    try {
      const bin = config.OPENCODE_BIN_PATH || 'opencode';
      const { stdout } = await execFileAsync(bin, ['models'], { timeout: 4000 });
      const parsed = parseOpenCodeModels(stdout);
      if (parsed.length > 0) return parsed;
    } catch {
      // Fallback
    }
  }

  // Fallback to curated models for this agent
  return DEFAULT_MODELS_BY_AGENT[norm] || DEFAULT_MODELS_BY_AGENT.claude;
}

function parseAntigravityModels(output: string): AvailableModel[] {
  const lines = output.split('\n');
  const models: AvailableModel[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|Fetching available models\.\.\./g, '').trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-zA-Z0-9._\-\/]+)\s+(.+)$/);
    if (match) {
      models.push({ id: match[1].trim(), label: match[2].trim() });
    } else if (/^[a-zA-Z0-9._\-\/]+$/.test(trimmed)) {
      models.push({ id: trimmed, label: trimmed });
    }
  }
  return models;
}

function parseOpenCodeModels(output: string): AvailableModel[] {
  const lines = output.split('\n');
  const models: AvailableModel[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('error') || trimmed.includes('WARNING')) continue;
    const match = trimmed.match(/^([a-zA-Z0-9._\-\/]+)(?:\s+(.+))?$/);
    if (match) {
      const id = match[1].trim();
      const rawLabel = match[2]?.trim() || id;
      const label = rawLabel.replace(/^opencode\//, '');
      models.push({ id, label });
    }
  }
  return models;
}
