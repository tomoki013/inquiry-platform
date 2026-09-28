-- Mail delivery belongs to a Project, not to the shared Worker deployment.
-- NULL means "use the deployment-wide environment fallback". Keeping the
-- columns nullable makes this migration backwards-compatible with existing
-- signature-only rows and lets Tomokichi's current mail continue unchanged.
ALTER TABLE app_mail_settings ADD COLUMN support_email TEXT;
ALTER TABLE app_mail_settings ADD COLUMN from_name TEXT;
ALTER TABLE app_mail_settings ADD COLUMN noreply_email TEXT;
ALTER TABLE app_mail_settings ADD COLUMN notification_email TEXT;
