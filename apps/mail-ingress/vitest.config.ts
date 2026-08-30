import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        /**
         * `tomokichi-admin-core` is a real Worker in the account, not something
         * miniflare can conjure — without this the runtime refuses to start
         * because the binding points at a service it cannot find.
         *
         * A stub is the right answer rather than a second copy of Admin Core:
         * the tests below call the email handler with an env they build
         * themselves, so what they exercise is this Worker's own decisions —
         * parse, hand over, forward — and never Admin Core's.
         */
        serviceBindings: {
          ADMIN_CORE: () => new Response("stub", { status: 501 }),
        },
      },
    }),
  ],
  test: { include: ["src/**/*.test.ts"] },
});
