#!/usr/bin/env node
// Copies packages/sdk into a project repository as a workspace package.
//
//   node scripts/vendor-sdk.mjs ../tomokichi-studio/packages/inquiry-sdk
//   node scripts/vendor-sdk.mjs ../tomokichi-studio/packages/inquiry-sdk --check
//
// Vendored rather than published: this repository is private, and a project's
// public CI should not need a token to install its dependencies. The SDK has
// no dependencies of its own, so a copy is the whole of it. `--check` exits 1
// when the copy differs from this checkout, for use before a release.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages/sdk");
const [target, flag] = process.argv.slice(2);
if (!target) {
  console.error("Usage: vendor-sdk.mjs <target-dir> [--check]");
  process.exit(2);
}
const dest = resolve(target);
const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const files = readdirSync(join(source, "src")).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);
const header =
  "// Vendored from inquiry-platform packages/sdk. Do not edit here; see VENDORED.md.\n";

const expected = new Map(
  files.map((name) => [
    join("src", name),
    header + readFileSync(join(source, "src", name), "utf8"),
  ]),
);
expected.set(
  "package.json",
  `${JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts" },
      scripts: { check: "tsc --noEmit" },
      devDependencies: { typescript: pkg.devDependencies.typescript },
    },
    null,
    2,
  )}\n`,
);
expected.set("tsconfig.json", readFileSync(join(source, "tsconfig.json"), "utf8"));

if (flag === "--check") {
  const differs = [...expected].filter(([path, content]) => {
    try {
      return readFileSync(join(dest, path), "utf8") !== content;
    } catch {
      return true;
    }
  });
  if (differs.length) {
    console.error(`Out of date: ${differs.map(([path]) => path).join(", ")}`);
    process.exit(1);
  }
  console.log("Vendored SDK matches this checkout.");
  process.exit(0);
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
rmSync(join(dest, "src"), { recursive: true, force: true });
for (const [path, content] of expected) {
  mkdirSync(dirname(join(dest, path)), { recursive: true });
  writeFileSync(join(dest, path), content);
}
writeFileSync(
  join(dest, "VENDORED.md"),
  `# @inquiry-platform/sdk (vendored)

A copy of \`packages/sdk\` from the private inquiry-platform repository, version
${pkg.version}, commit \`${commit}\`. Do not edit these files here: change the SDK
there and run, from the inquiry-platform checkout,

\`\`\`
node scripts/vendor-sdk.mjs <this directory>
\`\`\`
`,
);
console.log(`Vendored @inquiry-platform/sdk ${pkg.version} (${commit.slice(0, 7)}) into ${dest}`);
