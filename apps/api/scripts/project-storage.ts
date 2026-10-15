import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  type SchemaObject,
  type StorageSchema,
  sealStorageSql,
  storageMigration,
} from "../src/storage/migration.ts";
import { type StorageTable, storageTables } from "../src/storage/schema.ts";

const [phase, slug, prefix, table, limit] = process.argv.slice(2);
if (phase === "seal") {
  process.stdout.write(sealStorageSql());
  process.exit(0);
}
if (
  !phase ||
  !slug ||
  !prefix ||
  !["prepare", "copy", "verify", "cutover", "tables"].includes(phase)
) {
  throw new Error(
    "Usage: project-storage <prepare|copy|verify|cutover|tables> <registered-service-slug> <p_storage_prefix> [legacy-table] [batch-size]",
  );
}
// This database is in memory. The tool prints reviewable SQL; it cannot connect
// to Cloudflare or apply anything to a deployment.
const db = new DatabaseSync(":memory:");
const directory = new URL("../migrations/", import.meta.url);
for (const file of readdirSync(directory)
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  db.exec(readFileSync(new URL(file, directory), "utf8"));
}
const objects = db
  .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL")
  .all() as unknown as SchemaObject[];
const columns = Object.fromEntries(
  storageTables.map((name) => [
    name,
    (db.prepare(`PRAGMA table_info(${name})`).all() as unknown as { name: string }[]).map(
      (c) => c.name,
    ),
  ]),
) as StorageSchema["columns"];
const result = storageMigration({ objects, columns }, { slug, prefix });
if (phase === "copy" && table)
  process.stdout.write(result.backfill(table as StorageTable, limit ? Number(limit) : undefined));
else
  process.stdout.write(
    phase === "tables"
      ? result.tables.join("\n")
      : result[phase as "prepare" | "copy" | "verify" | "cutover"],
  );
process.stdout.write("\n");
db.close();
