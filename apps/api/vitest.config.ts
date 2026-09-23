import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { unstable_splitSqlQuery } from "wrangler";

// Exercise the deployment splitter too: CASE token spacing inside triggers matters.
for (const file of readdirSync(new URL("./migrations/", import.meta.url))) {
  if (!file.endsWith(".sql")) continue;
  const sql = readFileSync(new URL(`./migrations/${file}`, import.meta.url), "utf8");
  for (const statement of unstable_splitSqlQuery(sql)) {
    if (/^CREATE TRIGGER/i.test(statement.trim()) && !/\bEND\s*;?\s*$/.test(statement)) {
      throw new Error(`Wrangler cannot split ${file}: incomplete trigger`);
    }
  }
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Every test file gets its own database, applied from `migrations/` by
        // `tests/harness.ts`, so nothing leaks between suites.
        serviceBindings: { REMEET_MODERATION: () => new Response("stub", { status: 501 }) },
        d1Databases: ["DB"],
        r2Buckets: ["PRIVATE_FILES"],
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
