-- Whether a project's new tickets are announced by mail. 0 turns the mail off
-- for that project (push is unaffected), for a project that already receives
-- each message in its own inbox. NULL keeps the current behaviour, so existing
-- projects are unchanged until they set it.
ALTER TABLE app_mail_settings ADD COLUMN notify_by_email INTEGER CHECK (notify_by_email IN (0, 1));
