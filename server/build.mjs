// Bundles the server entrypoints (and the shared workspace package) into dist/.
// Third-party dependencies stay external and are installed in the runtime image.
import { build } from "esbuild";

const entries = {
  main: "src/main.ts",
  worker: "src/worker.ts",
  migrate: "src/cli/migrate.ts",
  seed: "src/cli/seed.ts",
  "create-user": "src/cli/create-user.ts",
  "reset-password": "src/cli/reset-password.ts",
  bench: "src/cli/bench.ts",
};

await build({
  entryPoints: entries,
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  plugins: [
    {
      name: "externalize-deps",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => (args.path.startsWith("@clubcal/") ? undefined : { path: args.path, external: true }));
      },
    },
  ],
});
