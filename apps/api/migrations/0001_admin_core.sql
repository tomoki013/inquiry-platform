-- Tomokichi Studio Admin — initial schema.
--
-- Forward-only. Nothing here drops, truncates or rewrites an existing table:
-- this database is where the record of what was reported and what was done
-- about it lives, and a migration that can lose that is not worth the tidiness.
--
-- Every id is a UUID the application generated (see `newId()`), and every
-- timestamp is UTC ISO 8601 text. D1 has no native uuid or timestamp type, and
-- an autoincrementing integer would let one report id be guessed from another.

-- ---------------------------------------------------------------- apps ----
-- One row per Studio app. Never deleted — `archived_at` is set instead, so the
-- reports and threads that point here keep pointing at something.
CREATE TABLE IF NOT EXISTS apps (
    id            TEXT PRIMARY KEY,
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    platform      TEXT NOT NULL,
    status        TEXT NOT NULL,
    description   TEXT,
    bundle_id     TEXT,
    public_url    TEXT,
    support_url   TEXT,
    app_store_url TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    archived_at   TEXT
);

CREATE TABLE IF NOT EXISTS app_links (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES apps(id),
    type       TEXT NOT NULL,
    label      TEXT NOT NULL,
    url        TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_links_app ON app_links(app_id, sort_order);

-- ------------------------------------------------------------- reports ----
-- `external_report_id` is the reporting app's own id and is UNIQUE, which is
-- the whole idempotency story: a phone retrying on a bad connection produces
-- one row, and the second attempt is answered with the first row's id.
CREATE TABLE IF NOT EXISTS reports (
    id                    TEXT PRIMARY KEY,
    app_id                TEXT NOT NULL REFERENCES apps(id),
    external_report_id    TEXT NOT NULL,
    context_external_id   TEXT,
    content_type          TEXT NOT NULL,
    content_external_id   TEXT,
    -- Pseudonymised references, not the apps' own user ids. See
    -- `pseudonymise()` in src/domain/identity.ts.
    reporter_ref_hash     TEXT,
    author_ref_hash       TEXT,
    reason_code           TEXT NOT NULL,
    detail                TEXT,
    snapshot_text         TEXT,
    status                TEXT NOT NULL,
    priority              TEXT NOT NULL DEFAULT 'normal',
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    resolved_at           TEXT,
    resolution_code       TEXT,
    resolution_note       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_external ON reports(external_report_id);
CREATE INDEX IF NOT EXISTS idx_reports_app ON reports(app_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at);

-- Append-only history. Nothing in the application deletes from this table.
CREATE TABLE IF NOT EXISTS report_events (
    id          TEXT PRIMARY KEY,
    report_id   TEXT NOT NULL REFERENCES reports(id),
    event_type  TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    actor_id    TEXT,
    note        TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_events_report ON report_events(report_id, created_at);

-- Metadata only. The bytes are in R2 under `reports/{reportId}/{attachmentId}`,
-- in a private bucket with no public URL.
CREATE TABLE IF NOT EXISTS report_attachments (
    id                TEXT PRIMARY KEY,
    report_id         TEXT NOT NULL REFERENCES reports(id),
    r2_key            TEXT NOT NULL,
    content_type      TEXT NOT NULL,
    original_filename TEXT,
    byte_size         INTEGER NOT NULL,
    sha256            TEXT NOT NULL,
    created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_attachments_report ON report_attachments(report_id);

-- ------------------------------------------------------------- support ----
CREATE TABLE IF NOT EXISTS support_threads (
    id              TEXT PRIMARY KEY,
    app_id          TEXT REFERENCES apps(id),
    source          TEXT NOT NULL,
    requester_email TEXT NOT NULL,
    -- Only ever a name the person typed. Never derived from the address.
    requester_name  TEXT,
    subject         TEXT NOT NULL,
    status          TEXT NOT NULL,
    unread_count    INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_threads_app ON support_threads(app_id);
CREATE INDEX IF NOT EXISTS idx_support_threads_status ON support_threads(status);
CREATE INDEX IF NOT EXISTS idx_support_threads_last_message ON support_threads(last_message_at);

-- `direction` is what separates a customer's mail, our reply, and a note that
-- must never leave the building. One table so the timeline is one ordered list.
CREATE TABLE IF NOT EXISTS support_messages (
    id                  TEXT PRIMARY KEY,
    thread_id           TEXT NOT NULL REFERENCES support_threads(id),
    direction           TEXT NOT NULL,
    provider_message_id TEXT,
    in_reply_to         TEXT,
    sender              TEXT,
    recipient           TEXT,
    -- The finished text as it was sent. Never re-rendered from a template:
    -- editing a template must not change what somebody was actually told.
    body_text           TEXT NOT NULL,
    created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_support_messages_provider ON support_messages(provider_message_id);

CREATE TABLE IF NOT EXISTS support_attachments (
    id                TEXT PRIMARY KEY,
    message_id        TEXT NOT NULL REFERENCES support_messages(id),
    r2_key            TEXT NOT NULL,
    original_filename TEXT,
    content_type      TEXT NOT NULL,
    byte_size         INTEGER NOT NULL,
    sha256            TEXT NOT NULL,
    created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_attachments_message ON support_attachments(message_id);

-- One live draft per thread, which is why `thread_id` is the primary key. A
-- draft is deleted only after the provider has accepted the mail.
CREATE TABLE IF NOT EXISTS support_drafts (
    thread_id  TEXT PRIMARY KEY REFERENCES support_threads(id),
    body_text  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Guards against a retried or double-clicked send. Written in the same batch
-- as the outbound message, so a key exists if and only if the mail was
-- recorded as sent.
CREATE TABLE IF NOT EXISTS support_reply_sends (
    idempotency_key TEXT PRIMARY KEY,
    thread_id       TEXT NOT NULL REFERENCES support_threads(id),
    message_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

-- ------------------------------------------------------ reply templates ----
-- `app_id IS NULL` means Studio-wide. `key` is the stable handle the seed
-- re-runs against, so seeding twice creates nothing twice and never overwrites
-- an edit made in the admin screen.
CREATE TABLE IF NOT EXISTS reply_templates (
    id                TEXT PRIMARY KEY,
    key               TEXT NOT NULL UNIQUE,
    name              TEXT NOT NULL,
    category          TEXT NOT NULL,
    app_id            TEXT REFERENCES apps(id),
    body              TEXT NOT NULL,
    -- Structural, rather than searching the body for the signature's text.
    include_signature INTEGER NOT NULL DEFAULT 1,
    is_active         INTEGER NOT NULL DEFAULT 1,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reply_templates_scope ON reply_templates(app_id, is_active, sort_order);

-- The Studio-wide default is the row whose `app_id` is NULL, which is why this
-- is a unique index over an expression rather than a primary key on app_id.
CREATE TABLE IF NOT EXISTS app_mail_settings (
    app_id         TEXT REFERENCES apps(id),
    signature_text TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_mail_settings_scope
    ON app_mail_settings(COALESCE(app_id, ''));

-- ----------------------------------------------------------- audit log ----
-- Never pruned by the application, which is exactly why `metadata_json` may
-- hold only ids, codes and counts — see `assertSafeAuditMetadata`.
CREATE TABLE IF NOT EXISTS audit_logs (
    id            TEXT PRIMARY KEY,
    actor_type    TEXT NOT NULL,
    actor_id      TEXT,
    action        TEXT NOT NULL,
    target_type   TEXT NOT NULL,
    target_id     TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
