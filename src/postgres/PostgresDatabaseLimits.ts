export const POSTGRES_DATABASE_LIMITS = {
  /** A provider admits at most two inspections simultaneously. */
  concurrentInspections: 2,
  /** Bounded reply payload size matching REA SQLite standards (16 MiB). */
  maxReplyBytes: 16 * 1024 * 1024,
  /** Execution timeout defaults to 30s. */
  defaultTimeoutMs: 30_000,
  /** Maximum supported worker timer (32-bit signed integer). */
  maxTimeoutMs: 2_147_483_647,
} as const;
