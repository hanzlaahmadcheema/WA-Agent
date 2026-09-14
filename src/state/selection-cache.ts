import {
  SelectionExpiredError,
  InvalidArgumentError,
} from '../router/errors.js';

export type SelectionSource =
  | 'NAVIGATION_LS'
  | 'SESSION_LIST'
  | 'AGENT_LIST'
  | 'JOB_LIST'
  | 'NATIVE_CHAT_LIST'
  | 'MODEL_LIST';

export interface SelectionItem {
  index: number; // 1-based
  label: string; // e.g. "apps/", "package.json"
  value: string; // absolute path, session ID, agent name, or job ID
  type: 'dir' | 'file' | 'session' | 'agent' | 'job' | 'native_chat' | 'model';
  metadata?: Record<string, any>;
}

export interface UserSelectionCache {
  source: SelectionSource;
  createdAt: number;
  cwdAtListing: string;
  items: SelectionItem[];
}

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const userCaches = new Map<string, UserSelectionCache>();

export function setSelectionCache(
  userId: string,
  source: SelectionSource,
  cwdAtListing: string,
  items: SelectionItem[]
): void {
  userCaches.set(userId, {
    source,
    createdAt: Date.now(),
    cwdAtListing,
    items,
  });
}

export function getSelectionCache(userId: string): UserSelectionCache | null {
  const cache = userCaches.get(userId);
  if (!cache) return null;

  if (Date.now() - cache.createdAt > CACHE_TTL_MS) {
    userCaches.delete(userId);
    return null;
  }

  return cache;
}

export function clearSelectionCache(userId: string): void {
  userCaches.delete(userId);
}

export function resolveSelectionIndex(
  userId: string,
  index: number,
  currentCwd?: string,
  expectedType?: 'dir' | 'file' | 'session' | 'agent' | 'job' | 'native_chat' | 'model'
): SelectionItem {
  const cache = getSelectionCache(userId);
  if (!cache) {
    throw new SelectionExpiredError();
  }

  // If this was a navigation list and the directory has changed, invalidate
  if (
    cache.source === 'NAVIGATION_LS' &&
    currentCwd &&
    cache.cwdAtListing !== currentCwd
  ) {
    clearSelectionCache(userId);
    throw new SelectionExpiredError();
  }

  if (index < 1 || index > cache.items.length) {
    throw new InvalidArgumentError(
      `Index #${index} is out of range.`,
      `Valid range is 1 to ${cache.items.length}.`
    );
  }

  const item = cache.items[index - 1];

  if (expectedType && item.type !== expectedType) {
    const remedy =
      item.type === 'dir'
        ? `Use /cd ${index} to navigate into directories.`
        : item.type === 'file'
        ? `Use /view ${index} to view file contents.`
        : `Check the item type in the previous listing.`;

    throw new InvalidArgumentError(
      `Item #${index} is a ${item.type}, but expected a ${expectedType}.`,
      remedy
    );
  }

  return item;
}
