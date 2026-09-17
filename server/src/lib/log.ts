import { config } from "../config.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = Exclude<keyof typeof levels, "silent">;

function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (levels[level] < levels[config.LOG_LEVEL]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit("debug", m, e),
  info: (m: string, e?: Record<string, unknown>) => emit("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => emit("error", m, e),
};
