import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:3000", changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
