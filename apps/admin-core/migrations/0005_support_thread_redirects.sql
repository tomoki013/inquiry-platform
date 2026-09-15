-- Preserve old conversation URLs when a report reply was filed separately.
CREATE TABLE IF NOT EXISTS support_thread_redirects (
  source_thread_id TEXT PRIMARY KEY REFERENCES support_threads(id),
  target_thread_id TEXT NOT NULL REFERENCES support_threads(id),
  created_at TEXT NOT NULL,
  CHECK (source_thread_id <> target_thread_id)
);
