-- After the deployment seals storage, no stale Worker may create business
-- records in any legacy table, including newly registered/unassigned services.
CREATE TRIGGER IF NOT EXISTS sealed_support_threads_INSERT BEFORE INSERT ON support_threads
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_threads_UPDATE BEFORE UPDATE ON support_threads
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_threads_DELETE BEFORE DELETE ON support_threads
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_messages_INSERT BEFORE INSERT ON support_messages
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_messages_UPDATE BEFORE UPDATE ON support_messages
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_messages_DELETE BEFORE DELETE ON support_messages
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_attachments_INSERT BEFORE INSERT ON support_attachments
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_attachments_UPDATE BEFORE UPDATE ON support_attachments
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_attachments_DELETE BEFORE DELETE ON support_attachments
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_drafts_INSERT BEFORE INSERT ON support_drafts
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_drafts_UPDATE BEFORE UPDATE ON support_drafts
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_drafts_DELETE BEFORE DELETE ON support_drafts
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_reply_sends_INSERT BEFORE INSERT ON support_reply_sends
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_reply_sends_UPDATE BEFORE UPDATE ON support_reply_sends
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_reply_sends_DELETE BEFORE DELETE ON support_reply_sends
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_reply_attempts_INSERT BEFORE INSERT ON support_reply_attempts
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_reply_attempts_UPDATE BEFORE UPDATE ON support_reply_attempts
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_reply_attempts_DELETE BEFORE DELETE ON support_reply_attempts
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_thread_redirects_INSERT BEFORE INSERT ON support_thread_redirects
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_thread_redirects_UPDATE BEFORE UPDATE ON support_thread_redirects
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_support_thread_redirects_DELETE BEFORE DELETE ON support_thread_redirects
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_reports_INSERT BEFORE INSERT ON reports
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_reports_UPDATE BEFORE UPDATE ON reports
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_reports_DELETE BEFORE DELETE ON reports
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_events_INSERT BEFORE INSERT ON report_events
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_events_UPDATE BEFORE UPDATE ON report_events
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_events_DELETE BEFORE DELETE ON report_events
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_attachments_INSERT BEFORE INSERT ON report_attachments
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_attachments_UPDATE BEFORE UPDATE ON report_attachments
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_attachments_DELETE BEFORE DELETE ON report_attachments
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_operations_INSERT BEFORE INSERT ON report_operations
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_operations_UPDATE BEFORE UPDATE ON report_operations
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_report_operations_DELETE BEFORE DELETE ON report_operations
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_tickets_INSERT BEFORE INSERT ON tickets
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_tickets_UPDATE BEFORE UPDATE ON tickets
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_tickets_DELETE BEFORE DELETE ON tickets
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_sources_INSERT BEFORE INSERT ON ticket_sources
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_sources_UPDATE BEFORE UPDATE ON ticket_sources
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_sources_DELETE BEFORE DELETE ON ticket_sources
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_messages_INSERT BEFORE INSERT ON ticket_messages
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_messages_UPDATE BEFORE UPDATE ON ticket_messages
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_messages_DELETE BEFORE DELETE ON ticket_messages
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_events_INSERT BEFORE INSERT ON ticket_events
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_events_UPDATE BEFORE UPDATE ON ticket_events
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_events_DELETE BEFORE DELETE ON ticket_events
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_reports_INSERT BEFORE INSERT ON ticket_reports
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_reports_UPDATE BEFORE UPDATE ON ticket_reports
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_reports_DELETE BEFORE DELETE ON ticket_reports
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_relations_INSERT BEFORE INSERT ON ticket_relations
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_relations_UPDATE BEFORE UPDATE ON ticket_relations
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

CREATE TRIGGER IF NOT EXISTS sealed_ticket_relations_DELETE BEFORE DELETE ON ticket_relations
WHEN (SELECT value FROM platform_settings WHERE key='project_storage_required')='1'
BEGIN
SELECT RAISE(ABORT,'ProjectStorageRequired');
END;

