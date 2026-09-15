ALTER TABLE support_threads ADD COLUMN mail_subject TEXT;
ALTER TABLE support_messages ADD COLUMN transport_id TEXT;
ALTER TABLE reports ADD COLUMN support_thread_id TEXT REFERENCES support_threads(id);
CREATE INDEX IF NOT EXISTS support_messages_transport ON support_messages(transport_id);
UPDATE support_messages SET transport_id = provider_message_id, provider_message_id = NULL
 WHERE direction = 'outbound' AND provider_message_id IS NOT NULL AND provider_message_id NOT LIKE '<%@%>';
UPDATE app_mail_settings SET signature_text = 'Tomokichi Studio
髙木友喜 / Tomoki Takagi
────────────────────────
https://tmkch.io
support@tmkch.io  ·  080-6648-1475'
 WHERE signature_text LIKE '%髙木 友喜%';
CREATE TABLE IF NOT EXISTS report_operations (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id),
  decision TEXT NOT NULL CHECK(decision IN ('delete','dismiss')),
  completed_at TEXT
);

ALTER TABLE support_messages ADD COLUMN message_id_checked_at TEXT;
ALTER TABLE reports ADD COLUMN moderation_revision INTEGER NOT NULL DEFAULT 0;
