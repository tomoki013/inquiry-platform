import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Two suites, two environments.
 *
 * `src/worker` is tested in the real Workers runtime by `vitest.worker.config.ts`;
 * the React screens are tested here under jsdom. Splitting them is the only way
 * to have both — a single project cannot be `workerd` and a browser at once.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/client/**/*.test.tsx", "src/client/**/*.test.ts"],
    setupFiles: ["./src/client/test-setup.ts"],
  },
});
