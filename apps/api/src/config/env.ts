import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url().optional(),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().default('restaurant-os'),
    JWT_AUDIENCE: z.string().default('restaurant-os-api'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
    SESSION_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),

    LOGIN_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(5),
    LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(15 * 60),
    PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 60),

    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
    COOKIE_SECURE: bool.optional(),
    TRUST_PROXY: bool.default('false'),

    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),

    APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    MAIL_TRANSPORT: z.enum(['log', 'memory', 'smtp']).default('log'),
    /** smtp(s)://user:pass@host:port — any provider (SES SMTP, SendGrid, Zoho, Gmail Workspace…). */
    SMTP_URL: z.string().url().optional(),
    MAIL_FROM: z.string().default('RestaurantOS <no-reply@localhost>'),
    /** Bearer token for GET /api/v1/metrics (Prometheus). Unset: the endpoint is off. */
    METRICS_TOKEN: z.string().min(24, 'METRICS_TOKEN must be at least 24 characters').optional(),
    SWAGGER_ENABLED: bool.optional(),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    UPLOAD_DIR: z.string().default('./uploads'),
    /** Receipts and other private documents (local driver); never served as static files. */
    PRIVATE_UPLOAD_DIR: z.string().default('./uploads-private'),
    S3_PRESIGN_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    UPLOAD_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
    UPLOAD_MAX_RECEIPT_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('ap-south-1'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool.default('false'),
    S3_PUBLIC_BASE_URL: z.string().url().optional(),

    /** Realtime relay: how often committed events are published, and how long they stay replayable. */
    REALTIME_ENABLED: bool.default('true'),
    REALTIME_POLL_MS: z.coerce.number().int().min(20).max(10_000).default(200),
    REALTIME_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  })
  .superRefine((e, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (e.MAIL_TRANSPORT === 'smtp' && !e.SMTP_URL) issue('SMTP_URL', 'SMTP_URL is required when MAIL_TRANSPORT=smtp');
    if (e.NODE_ENV === 'production') {
      // Settings that are fine on a laptop but unsafe (or silently broken) on a live system.
      if (e.MAIL_TRANSPORT === 'memory') issue('MAIL_TRANSPORT', 'The memory mail transport cannot be used in production');
      if (e.COOKIE_SECURE === false) issue('COOKIE_SECURE', 'Cookies must be Secure in production (serve the API over HTTPS)');
      for (const o of e.CORS_ORIGINS) {
        if (o === '*' || !/^https:\/\//.test(o) || /\/\/(localhost|127\.0\.0\.1)(:|$)/.test(o)) {
          issue('CORS_ORIGINS', `CORS origin "${o}" is not allowed in production; list your https:// app domains`);
        }
      }
      if (!e.APP_PUBLIC_URL.startsWith('https://')) issue('APP_PUBLIC_URL', 'APP_PUBLIC_URL must be https:// in production');
      if (/^(test|dev|change|secret)/i.test(e.JWT_ACCESS_SECRET) || new Set(e.JWT_ACCESS_SECRET).size < 10) {
        issue('JWT_ACCESS_SECRET', 'JWT_ACCESS_SECRET looks like a placeholder; generate one with `openssl rand -base64 48`');
      }
    }
    if (e.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_PUBLIC_BASE_URL'] as const) {
        if (!e[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `${key} is required when STORAGE_DRIVER=s3` });
      }
    }
  })
  .transform((e) => ({
    ...e,
    COOKIE_SECURE: e.COOKIE_SECURE ?? e.NODE_ENV === 'production',
    SWAGGER_ENABLED: e.SWAGGER_ENABLED ?? e.NODE_ENV !== 'production',
  }));

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parses and validates process.env once. Fails fast with a readable message. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

export function resetEnvCache(): void {
  cached = undefined;
}

export const ENV = Symbol('ENV');
