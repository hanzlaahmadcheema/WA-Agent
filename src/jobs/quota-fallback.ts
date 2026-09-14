import { SUPPORTED_AGENTS } from '../commands/agent.cmd.js';

export interface QuotaFallbackContext {
  userId: string;
  projectId: string;
  sessionId: string;
  failedAgent: string;
  prompt: string;
  timestamp: number;
}

const fallbackStore = new Map<string, QuotaFallbackContext>();
const FALLBACK_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function isQuotaOrAuthError(errorMessage?: string | null): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return (
    lower.includes('quota reached') ||
    lower.includes('quota') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('not logged in') ||
    lower.includes('please run /login') ||
    lower.includes('429')
  );
}

export function setQuotaFallback(ctx: QuotaFallbackContext): void {
  fallbackStore.set(ctx.userId, ctx);
}

export function getQuotaFallback(userId: string): QuotaFallbackContext | null {
  const ctx = fallbackStore.get(userId);
  if (!ctx) return null;
  if (Date.now() - ctx.timestamp > FALLBACK_TTL_MS) {
    fallbackStore.delete(userId);
    return null;
  }
  return ctx;
}

export function clearQuotaFallback(userId: string): void {
  fallbackStore.delete(userId);
}

export function formatQuotaFallbackMessage(ctx: QuotaFallbackContext): string {
  const failedMeta = SUPPORTED_AGENTS.find((a) => a.name === ctx.failedAgent);
  const failedLabel = failedMeta?.label || ctx.failedAgent;

  // Alternate agents (excluding the failed one)
  const alternatives = SUPPORTED_AGENTS.filter((a) => a.name !== ctx.failedAgent);

  const lines: string[] = [
    `⚠️ *${failedLabel} Quota or Auth Limit Reached*`,
    '',
    `Task: _"${ctx.prompt.slice(0, 80)}"_`,
    '',
    '🔄 *Switch Agent & Auto-Retry Task:*',
  ];

  alternatives.forEach((alt, idx) => {
    lines.push(`  ${idx + 1}️⃣ Retry with *${alt.label}*`);
  });

  lines.push(
    '',
    `💬 _Reply with 1 to ${alternatives.length} to immediately switch and continue your task!_`
  );

  return lines.join('\n');
}

export function getAlternativeAgent(ctx: QuotaFallbackContext, choiceIndex: number): string | null {
  const alternatives = SUPPORTED_AGENTS.filter((a) => a.name !== ctx.failedAgent);
  const selected = alternatives[choiceIndex - 1];
  return selected ? selected.name : null;
}
