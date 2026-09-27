-- Where a contact that belongs to no Project is filed.
--
-- A support thread with no app_id becomes a ticket in the service named by
-- platform_settings.default_service_id, or in the built-in 'unassigned'
-- service when the deployment has not chosen one. A deployment sets its own
-- default with its seed.
--
-- Databases created before this setting existed had the default written into
-- the trigger itself. The INSERT below reads that value back out of the old
-- trigger so such a database keeps filing contacts exactly where it did,
-- before the trigger is replaced with the one that reads the setting. On a
-- database created from the current migrations there is nothing to read and
-- nothing is inserted. Replay-safe.
CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO platform_settings(key,value)
SELECT 'default_service_id',substr(rest,1,instr(rest,'''')-1)
FROM (SELECT substr(sql,instr(sql,'COALESCE(NEW.app_id,''')+21) AS rest FROM sqlite_master
      WHERE type='trigger' AND name='ticket_support_insert' AND instr(sql,'COALESCE(NEW.app_id,''')>0)
WHERE instr(rest,'''')>1;
DROP TRIGGER IF EXISTS ticket_support_insert;
CREATE TRIGGER ticket_support_insert AFTER INSERT ON support_threads 
BEGIN
INSERT OR IGNORE INTO ticket_numbers(ticket_id) VALUES(NEW.id);
INSERT OR IGNORE INTO tickets(id,ticket_number,type,status,resolution,priority,impact,urgency,service_id,subject,requester_email,created_at,updated_at,resolved_at,closed_at,sla_ack_minutes,sla_response_minutes,sla_resolution_minutes) VALUES(NEW.id,(SELECT 'TK-' || printf('%06d',seq) FROM ticket_numbers WHERE ticket_id=NEW.id),'INQUIRY','NEW',NULL,'P3','MEDIUM','MEDIUM',COALESCE(NEW.app_id,(SELECT value FROM platform_settings WHERE key='default_service_id'),'unassigned'),NEW.subject,NULLIF(NEW.requester_email,''),NEW.created_at,NEW.updated_at,NULL,NULL,(SELECT ack FROM ticket_sla_settings WHERE priority='P3'),(SELECT response FROM ticket_sla_settings WHERE priority='P3'),(SELECT resolution FROM ticket_sla_settings WHERE priority='P3'));
INSERT OR IGNORE INTO ticket_sources VALUES('support',NEW.id,NEW.id);
INSERT OR IGNORE INTO ticket_events VALUES('created:' || NEW.id,NEW.id,'TICKET_CREATED',NULL,'{}',NEW.created_at);
END;
