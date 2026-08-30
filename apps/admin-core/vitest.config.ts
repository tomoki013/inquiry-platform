import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Every test file gets its own database, applied from `migrations/` by
        // `tests/harness.ts`, so nothing leaks between suites.
        d1Databases: ["DB"],
        r2Buckets: ["PRIVATE_FILES"],
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
