/**
 * reminder-formatter.ts
 * Tiny utility to format a future Date as a human-readable countdown string.
 * e.g. "5 minutes", "2 hours", "3 days"
 */

export function formatDistanceToNow(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec} second${diffSec !== 1 ? 's' : ''}`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''}`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''}`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} day${diffDay !== 1 ? 's' : ''}`;
}
