ALTER TABLE report_attachments ADD COLUMN expired_at TEXT;
CREATE INDEX IF NOT EXISTS report_attachments_expiry ON report_attachments(created_at) WHERE expired_at IS NULL;
