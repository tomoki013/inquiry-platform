-- Web Push subscriptions and per-operator notification settings.
--
-- `endpoint`, `p256dh` and `auth` together are the ability to push to one
-- device. They are read by the notifier and by nothing that answers a browser.
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id            TEXT PRIMARY KEY,
    admin_user_id TEXT NOT NULL,
    endpoint      TEXT NOT NULL UNIQUE,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    user_agent    TEXT,
    device_name   TEXT,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_owner ON push_subscriptions(admin_user_id, revoked_at);

CREATE TABLE IF NOT EXISTS admin_notification_settings (
    admin_user_id TEXT PRIMARY KEY,
    inquiry_push  INTEGER NOT NULL DEFAULT 1,
    report_push   INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at    TEXT NOT NULL
);
