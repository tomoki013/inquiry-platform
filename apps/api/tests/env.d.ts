/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

/** Vite serves the migration file to `harness.ts` as a string, so the tests run
 * against the schema that actually ships rather than a fixture copy of it. */
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
