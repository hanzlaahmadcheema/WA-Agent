/**
 * reminder-formatter.ts
 * Formats future Dates into human-readable countdowns and timestamps with seconds precision.
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

/**
 * Returns multi-unit countdown: "1h 30m 15s" or "4m 20s" or "45s"
 */
export function formatPreciseCountdown(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';

  const totalSec = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.slice(0, 3).join(' ');
}

/**
 * Full timestamp with day of week, date, time, and seconds:
 * e.g. "Tue, Sep 15, 2026, 14:30:15"
 */
export function formatDateTimeFull(date: Date): string {
  return date.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
