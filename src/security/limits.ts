export const LIMITS = {
  // Payload & String boundaries
  MAX_PROMPT_CHARS: 10_000,
  MAX_MESSAGE_CHARS: 4_000,

  // Execution boundaries
  MAX_JOB_RUNTIME_MS: 15 * 60 * 1000, // 15 minutes maximum per task
  MAX_CONCURRENT_JOBS_PER_USER: 1,

  // Filesystem & Navigation boundaries
  MAX_GREP_MATCHES: 15,
  MAX_TREE_ENTRIES: 100,
  MAX_FILE_VIEW_BYTES: 10 * 1024 * 1024, // 10MB

  // Rate limits per user per 60 seconds
  RATE_LIMITS: {
    INBOUND_MESSAGES_PER_MIN: 30,
    RUN_PER_MIN: 5,
    FILESYSTEM_PER_MIN: 30,
  },
};
