CREATE TABLE IF NOT EXISTS inquiry_mcp_shares (
  actor_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  context_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inquiry_mcp_shares_expiry ON inquiry_mcp_shares(expires_at);
