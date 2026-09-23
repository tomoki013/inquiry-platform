-- Stable pseudonymous author identity already exists. Preserve all reports,
-- including closed reports, and index the admin-only history lookup.
CREATE INDEX IF NOT EXISTS reports_author_history
ON reports(app_id, author_ref_hash, created_at DESC, id DESC);
