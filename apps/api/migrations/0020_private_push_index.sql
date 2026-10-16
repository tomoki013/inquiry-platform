-- Existing endpoints remain readable until the Worker backfills their private copy.
ALTER TABLE push_subscriptions ADD COLUMN endpoint_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_hash ON push_subscriptions(endpoint_hash) WHERE endpoint_hash IS NOT NULL;
