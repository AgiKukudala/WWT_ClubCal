import { defineConfig } from "vitest/config";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/clubcal_test";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: "silent",
      APP_ORIGIN: "http://localhost:3000",
      PUBLIC_URL: "http://localhost:3000",
      LOGIN_MAX_FAILURES: "5",
    },
    // All files share one real PostgreSQL database, so run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
