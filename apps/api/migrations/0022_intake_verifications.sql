CREATE TABLE IF NOT EXISTS intake_verifications (
  project_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('inquiry','report')),
  request_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  source_id TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, domain, request_key)
);

CREATE INDEX IF NOT EXISTS idx_intake_verifications_expiry
  ON intake_verifications(expires_at) WHERE token_hash IS NOT NULL;
