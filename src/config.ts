import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

// Runtime Version Validation: Enforce Node >= 22.5.0 (for native node:sqlite DatabaseSync)
const [majorStr, minorStr] = process.versions.node.split('.');
const major = parseInt(majorStr, 10);
const minor = parseInt(minorStr, 10);

if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `❌ Unsupported Node.js runtime: v${process.versions.node}. Minimum required version: Node.js >= 22.5.0.`
  );
  process.exit(1);
}

dotenv.config();

const envSchema = z.object({
  ALLOWED_ROOTS: z
    .string()
    .min(1, 'ALLOWED_ROOTS must be specified')
    .transform((val) =>
      val
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(p))
    ),
  ADMIN_PHONE_NUMBER: z
    .string()
    .min(5, 'ADMIN_PHONE_NUMBER must be at least 5 digits')
    .regex(/^\d+$/, 'ADMIN_PHONE_NUMBER must contain only digits'),
  DATABASE_PATH: z
    .string()
    .default('./data/control_plane.db')
    .transform((p) => path.resolve(p)),
  LOG_DIR: z
    .string()
    .default('./data/logs')
    .transform((p) => path.resolve(p)),
  DEFAULT_AGENT: z.string().default('claude'),
  DEFAULT_MODEL: z.string().default('claude-3-7-sonnet'),
  CLAUDE_BIN_PATH: z.string().default('claude'),
  ANTIGRAVITY_BIN_PATH: z.string().default('agy'),
  CODEX_BIN_PATH: z.string().default('codex'),
  OPENCODE_BIN_PATH: z.string().default('opencode'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HEALTH_PORT: z.coerce.number().default(8080),
  HEALTH_ENABLED: z.coerce.boolean().default(true),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Configuration validation error:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

// Ensure runtime directories exist
if (!fs.existsSync(config.LOG_DIR)) {
  fs.mkdirSync(config.LOG_DIR, { recursive: true });
}
const dbDir = path.dirname(config.DATABASE_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
