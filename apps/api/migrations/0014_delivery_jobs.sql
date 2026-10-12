-- Durable delivery work. Payloads are internal; mail content stays in private R2.
CREATE TABLE IF NOT EXISTS delivery_jobs (
 id TEXT PRIMARY KEY, service_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('notification_email','notification_push','inbound_email','failure_alert')),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','failed','completed')),
 payload TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0,
 generation INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 lease_token TEXT, lease_until TEXT, last_error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS delivery_jobs_due ON delivery_jobs(state,next_attempt_at,lease_until);
CREATE INDEX IF NOT EXISTS delivery_jobs_scope ON delivery_jobs(service_id,state,updated_at);
CREATE TABLE IF NOT EXISTS delivery_progress (
 job_id TEXT NOT NULL REFERENCES delivery_jobs(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL, PRIMARY KEY(job_id,target_id)
);
