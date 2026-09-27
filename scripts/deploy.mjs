#!/usr/bin/env node
// Deploys this checkout with a deployment's own configuration.
//
//   node scripts/deploy.mjs <deployment-dir> check
//   node scripts/deploy.mjs <deployment-dir> migrate
//   node scripts/deploy.mjs <deployment-dir> seed [--dry-run]
//   node scripts/deploy.mjs <deployment-dir> deploy <api|admin|mail-ingress|all> [--dry-run]
//
// The `wrangler.jsonc` files in this repository are placeholders. A
// deployment keeps its real ones — Worker names, D1 id, routes, addresses,
// BRANDING — in its own repository, in one directory:
//
//   <deployment-dir>/api.jsonc           required
//   <deployment-dir>/admin.jsonc         required
//   <deployment-dir>/mail-ingress.jsonc  required
//   <deployment-dir>/seed.ts             optional, a DeploymentSeed module
//   <deployment-dir>/admin-assets/       optional, files laid over the admin
//                                        console's built assets (icons, favicon)
//
// Each file is copied next to the placeholder it replaces, as
// `apps/<app>/wrangler.deployment.jsonc` (git-ignored), and Wrangler is run
// there with `--config`. Paths inside the files (`main`, `migrations_dir`,
// `assets.directory`) are therefore relative to `apps/<app>/`, exactly as in
// the placeholders. See docs/operations/deployment.md.
//
// `check` is `wrangler deploy --dry-run` for all three and touches nothing.
// Everything else acts on the Cloudflare account Wrangler is logged in to.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPS = ["api", "admin", "mail-ingress"];
const CONFIG = "wrangler.deployment.jsonc";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [dirArg, command, target] = args.filter((arg) => arg !== "--dry-run");

function usage() {
  console.error(
    [
      "Usage: deploy.mjs <deployment-dir> <command>",
      "  check                                   wrangler deploy --dry-run for every Worker",
      "  migrate                                 apply D1 migrations (remote)",
      "  seed [--dry-run]                        apply <deployment-dir>/seed.ts (remote)",
      "  deploy <api|admin|mail-ingress|all> [--dry-run]",
    ].join("\n"),
  );
  process.exit(2);
}

if (!dirArg || !command) usage();
// Relative to where the command was started, also when run through `pnpm run`.
const deployment = resolve(process.env.INIT_CWD ?? process.cwd(), dirArg);

function run(cwd, bin, argv) {
  console.log(`\n$ (${cwd.slice(root.length + 1) || "."}) ${bin} ${argv.join(" ")}`);
  const result = spawnSync(bin, argv, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function stage(app) {
  const source = join(deployment, `${app}.jsonc`);
  if (!existsSync(source)) {
    console.error(`Missing ${source}`);
    process.exit(1);
  }
  const cwd = join(root, "apps", app);
  copyFileSync(source, join(cwd, CONFIG));
  return cwd;
}

function wrangler(app, argv) {
  run(stage(app), "pnpm", ["exec", "wrangler", ...argv, "--config", CONFIG]);
}

function deploy(app, onlyCheck) {
  // The admin console's client is static assets the Worker serves. A
  // deployment's own icons replace the neutral ones after the build.
  if (app === "admin") {
    run(join(root, "apps", app), "pnpm", ["run", "build"]);
    const assets = join(deployment, "admin-assets");
    if (existsSync(assets)) {
      cpSync(assets, join(root, "apps/admin/dist"), { recursive: true });
      console.log(`Laid ${assets} over apps/admin/dist`);
    }
  }
  wrangler(app, onlyCheck ? ["deploy", "--dry-run"] : ["deploy"]);
}

switch (command) {
  case "check":
    for (const app of APPS) deploy(app, true);
    break;
  case "migrate":
    wrangler("api", ["d1", "migrations", "apply", "DB", "--remote"]);
    break;
  case "seed": {
    const seed = join(deployment, "seed.ts");
    if (!existsSync(seed)) {
      console.error(`Missing ${seed}`);
      process.exit(1);
    }
    const generated = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/seed.ts", seed],
      { cwd: join(root, "apps/api"), encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    if (generated.status !== 0) process.exit(generated.status ?? 1);
    const file = join(mkdtempSync(join(tmpdir(), "inquiry-seed-")), "seed.sql");
    writeFileSync(file, generated.stdout);
    console.log(`Seed SQL written to ${file}`);
    if (dryRun) {
      process.stdout.write(generated.stdout);
      break;
    }
    wrangler("api", ["d1", "execute", "DB", "--remote", "--file", file]);
    break;
  }
  case "deploy": {
    const apps = target === "all" ? APPS : APPS.includes(target) ? [target] : usage();
    // api first: the other two bind to it, and a Service Binding cannot point
    // at a Worker that does not exist yet.
    for (const app of apps) deploy(app, dryRun);
    break;
  }
  default:
    usage();
}
