-- Recoverable publish attempts. Existing completed decisions keep their marker.
ALTER TABLE report_operations ADD COLUMN lease_token TEXT;
ALTER TABLE report_operations ADD COLUMN lease_until TEXT;
ALTER TABLE report_operations ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_operations ADD COLUMN last_error TEXT;
