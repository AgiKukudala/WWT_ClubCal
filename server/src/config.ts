import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1).default("postgres://postgres@localhost:54329/clubcal"),
  /** Used to sign nothing secret-bearing today, but required so deployments must set one. */
  SESSION_SECRET: z.string().min(16).default("dev-only-insecure-session-secret"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),
  /** Comma separated list of origins allowed to make state-changing requests. */
  APP_ORIGIN: z.string().default("http://localhost:3000,http://localhost:5173"),
  STATIC_DIR: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  MAIL_FROM: z.string().default("ClubCal <no-reply@clubcal.local>"),
  PUBLIC_URL: z.string().default("http://localhost:3000"),
  REMINDER_POLL_SECONDS: z.coerce.number().int().min(1).max(300).default(15),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = envSchema.parse(env);
  if (cfg.NODE_ENV === "production" && cfg.SESSION_SECRET === "dev-only-insecure-session-secret") {
    throw new Error("SESSION_SECRET must be set in production");
  }
  return cfg;
}

export const config = loadConfig();

export function cookieSecure(): boolean {
  if (config.COOKIE_SECURE === "auto") return config.NODE_ENV === "production";
  return config.COOKIE_SECURE === "true";
}

export const allowedOrigins = () => config.APP_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
