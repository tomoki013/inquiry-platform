-- Freeze the provider key before sending. A retry spanning storage cutover
-- reuses the original key, even if the provider accepted before D1 committed.
CREATE TABLE IF NOT EXISTS support_reply_attempts (
  idempotency_key TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES support_threads(id),
  provider_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS support_reply_attempts_thread ON support_reply_attempts(thread_id);
