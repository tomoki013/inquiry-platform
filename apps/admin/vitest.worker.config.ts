import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // See apps/mail-ingress/vitest.config.ts: the binding names a real
        // Worker, and these tests supply their own fake in its place.
        serviceBindings: {
          ADMIN_CORE: () => new Response("stub", { status: 501 }),
        },
      },
    }),
  ],
  test: { include: ["src/worker/**/*.test.ts"] },
});
