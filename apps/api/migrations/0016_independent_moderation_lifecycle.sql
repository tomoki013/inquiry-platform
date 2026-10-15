-- Receiving mail changes the communication, never a moderation decision.
DROP TRIGGER IF EXISTS ticket_message_insert;
CREATE TRIGGER ticket_message_insert AFTER INSERT ON support_messages 
BEGIN
INSERT OR IGNORE INTO ticket_messages SELECT NEW.id,s.ticket_id, CASE NEW.direction WHEN 'inbound' THEN 'INBOUND' ELSE 'OUTBOUND' END , CASE NEW.direction WHEN 'internal_note' THEN 'INTERNAL' ELSE 'PUBLIC' END ,NEW.sender, CASE WHEN NEW.direction<>'internal_note' THEN NEW.recipient END ,NULL,NEW.body_text,NEW.created_at,NEW.id,0 FROM ticket_sources s WHERE s.source_type='support' AND s.source_id=NEW.thread_id;
INSERT OR IGNORE INTO ticket_events SELECT 'message:' || NEW.id,s.ticket_id, CASE NEW.direction WHEN 'inbound' THEN 'MESSAGE_RECEIVED' WHEN 'outbound' THEN 'MESSAGE_SENT' ELSE 'INTERNAL_NOTE_ADDED' END ,NEW.sender,json_object('messageId',NEW.id),NEW.created_at FROM ticket_sources s WHERE s.source_type='support' AND s.source_id=NEW.thread_id;
INSERT OR IGNORE INTO ticket_events SELECT 'reopen:' || NEW.id,t.id,'REOPENED',NULL,json_object('previousStatus',t.status,'newStatus','IN_PROGRESS','reason','inbound_reply'),NEW.created_at FROM tickets t JOIN ticket_sources s ON s.ticket_id=t.id WHERE s.source_type='support' AND s.source_id=NEW.thread_id AND NEW.direction='inbound' AND t.status IN ('RESOLVED','CLOSED') AND t.merged_into IS NULL AND NOT EXISTS(SELECT 1 FROM ticket_sources z WHERE z.ticket_id=t.id AND z.source_type='report');
INSERT OR IGNORE INTO ticket_events SELECT 'resume:' || NEW.id,t.id,'STATUS_CHANGED',NULL,json_object('previousStatus',t.status,'newStatus','IN_PROGRESS','reason','inbound_reply'),NEW.created_at FROM tickets t JOIN ticket_sources s ON s.ticket_id=t.id WHERE s.source_type='support' AND s.source_id=NEW.thread_id AND NEW.direction='inbound' AND t.status='WAITING_CUSTOMER' AND NOT EXISTS(SELECT 1 FROM ticket_sources z WHERE z.ticket_id=t.id AND z.source_type='report');
UPDATE tickets SET updated_at=NEW.created_at,revision=revision+1,
 resolution= CASE WHEN NEW.direction='inbound' AND status IN ('RESOLVED','CLOSED') AND merged_into IS NULL AND NOT EXISTS(SELECT 1 FROM ticket_sources z WHERE z.ticket_id=tickets.id AND z.source_type='report') THEN NULL ELSE resolution END ,
 resolved_at= CASE WHEN NEW.direction='inbound' AND status IN ('RESOLVED','CLOSED') AND merged_into IS NULL AND NOT EXISTS(SELECT 1 FROM ticket_sources z WHERE z.ticket_id=tickets.id AND z.source_type='report') THEN NULL ELSE resolved_at END ,
 closed_at= CASE WHEN NEW.direction='inbound' AND status IN ('RESOLVED','CLOSED') AND merged_into IS NULL AND NOT EXISTS(SELECT 1 FROM ticket_sources z WHERE z.ticket_id=tickets.id AND z.source_type='report') THEN NULL ELSE closed_at END ,
 status= CASE WHEN NEW.direction='inbound' AND status IN ('WAITING_CUSTOMER','RESOLVED','CLOSED') AND merged_into IS NULL AND NOT EXISTS(SELECT 1 FROM ticket_sources z WHERE z.ticket_id=tickets.id AND z.source_type='report') THEN 'IN_PROGRESS' ELSE status END
 WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=NEW.thread_id);


END;

-- Existing states and decisions are retained. Only subsequent domain changes
-- update the operator-facing compatibility projection.
DROP TRIGGER IF EXISTS ticket_report_decision;
CREATE TRIGGER ticket_report_decision AFTER UPDATE OF status,resolution_code,moderation_revision ON reports
WHEN NEW.status<>OLD.status OR NEW.resolution_code IS NOT OLD.resolution_code OR NEW.moderation_revision>OLD.moderation_revision
BEGIN
UPDATE tickets SET
 status= CASE NEW.status WHEN 'reviewing' THEN 'TRIAGE' WHEN 'actioned' THEN 'RESOLVED' WHEN 'closed' THEN 'CLOSED' ELSE 'NEW' END ,
 resolution= CASE WHEN NEW.status IN ('closed','actioned') THEN CASE NEW.resolution_code WHEN 'content_removed' THEN 'CONTENT_REMOVED' WHEN 'content_deleted' THEN 'CONTENT_REMOVED' WHEN 'no_action_required' THEN 'NO_ACTION_REQUIRED' WHEN 'no_action' THEN 'NO_ACTION_REQUIRED' ELSE 'OTHER' END ELSE NULL END ,
 resolved_at=NEW.resolved_at,closed_at= CASE WHEN NEW.status='closed' THEN NEW.resolved_at ELSE NULL END ,updated_at=NEW.updated_at,revision=revision+1
 WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='report' AND source_id=NEW.id);
END;
