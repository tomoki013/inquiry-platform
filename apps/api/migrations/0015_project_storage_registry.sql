-- Storage prefixes are deployment-owned identifiers, never request slugs.
-- Register physical tables with generated, version-controlled migrations.
CREATE TABLE IF NOT EXISTS project_storage (
  project_id TEXT PRIMARY KEY REFERENCES services(id),
  table_prefix TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK(schema_version = 1),
  state TEXT NOT NULL DEFAULT 'copying' CHECK(state IN ('copying','active')),
  activated_at TEXT
);
-- Opaque references only. A colliding id must fail, never join two products.
CREATE TABLE IF NOT EXISTS project_record_ids (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES services(id),
  PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS project_storage_checks (
  project_id TEXT PRIMARY KEY,
  mismatches INTEGER NOT NULL CHECK(mismatches = 0)
);
