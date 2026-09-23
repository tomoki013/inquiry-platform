-- Keep whitespace around CASE / END: Wrangler splits compound SQL using these tokens.
-- Additive and replay-safe. Legacy transport/evidence rows remain intact.
CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS service_components (id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id), name TEXT NOT NULL, slug TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, UNIQUE(service_id,slug));
CREATE TABLE IF NOT EXISTS ticket_categories (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, UNIQUE(type,slug));
CREATE TABLE IF NOT EXISTS assignment_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS ticket_assignees (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS ticket_sla_settings (priority TEXT PRIMARY KEY, ack INTEGER NOT NULL CHECK(ack>0), response INTEGER NOT NULL CHECK(response>0), resolution INTEGER CHECK(resolution>0));
INSERT OR IGNORE INTO ticket_sla_settings VALUES ('P1',15,30,240),('P2',60,240,1440),('P3',480,1440,4320),('P4',1440,2880,NULL);
INSERT OR IGNORE INTO services VALUES ('studio','tmkch.io','tmkch-io',1);
INSERT OR IGNORE INTO services SELECT id,name,slug, CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END FROM apps;
INSERT OR IGNORE INTO assignment_groups VALUES ('support','Support',1),('moderation','Moderation',1),('engineering','Engineering',1),('security','Security',1),('legal','Legal',1);
CREATE TABLE IF NOT EXISTS ticket_numbers (seq INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS tickets (
 id TEXT PRIMARY KEY, ticket_number TEXT NOT NULL UNIQUE,
 type TEXT NOT NULL CHECK(type IN ('INQUIRY','REPORT','BUG','INCIDENT','BILLING','PRIVACY','OTHER')),
 status TEXT NOT NULL CHECK(status IN ('NEW','TRIAGE','ACKNOWLEDGED','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL','RESOLVED','CLOSED')),
 resolution TEXT CHECK(resolution IN ('RESOLVED','NO_ACTION_REQUIRED','SPAM','DUPLICATE','INVALID','USER_WITHDREW','CONTENT_REMOVED','ACCOUNT_ACTIONED','FIXED','OTHER')),
 priority TEXT NOT NULL CHECK(priority IN ('P1','P2','P3','P4')), impact TEXT NOT NULL CHECK(impact IN ('HIGH','MEDIUM','LOW')), urgency TEXT NOT NULL CHECK(urgency IN ('HIGH','MEDIUM','LOW')), priority_override TEXT,
 service_id TEXT NOT NULL REFERENCES services(id), component_id TEXT REFERENCES service_components(id), category_id TEXT REFERENCES ticket_categories(id), assignment_group_id TEXT REFERENCES assignment_groups(id), assignee_id TEXT REFERENCES ticket_assignees(id),
 subject TEXT NOT NULL, summary TEXT, requester_id TEXT, requester_email TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, acknowledged_at TEXT, first_response_at TEXT, resolved_at TEXT, closed_at TEXT, next_action TEXT, next_action_at TEXT,
 mutation_id TEXT, revision INTEGER NOT NULL DEFAULT 0, merged_into TEXT REFERENCES tickets(id), sla_ack_minutes INTEGER NOT NULL, sla_response_minutes INTEGER NOT NULL, sla_resolution_minutes INTEGER,
 CHECK(status NOT IN ('RESOLVED','CLOSED') OR resolution IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_ticket_queue ON tickets(status,priority,created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_service ON tickets(service_id,type,updated_at);
CREATE INDEX IF NOT EXISTS idx_ticket_next ON tickets(next_action_at);
CREATE INDEX IF NOT EXISTS idx_ticket_assignee ON tickets(assignee_id,status);
CREATE TABLE IF NOT EXISTS ticket_sources (source_type TEXT NOT NULL, source_id TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id), PRIMARY KEY(source_type,source_id));
CREATE INDEX IF NOT EXISTS idx_ticket_sources_ticket ON ticket_sources(ticket_id);
CREATE TABLE IF NOT EXISTS ticket_messages (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), direction TEXT NOT NULL CHECK(direction IN ('INBOUND','OUTBOUND')), visibility TEXT NOT NULL CHECK(visibility IN ('PUBLIC','INTERNAL')), sender TEXT, recipient TEXT, subject TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL, legacy_message_id TEXT UNIQUE REFERENCES support_messages(id), is_automatic INTEGER NOT NULL DEFAULT 0, CHECK(visibility='PUBLIC' OR recipient IS NULL));
CREATE INDEX IF NOT EXISTS idx_ticket_messages_page ON ticket_messages(ticket_id,created_at,id);
CREATE TABLE IF NOT EXISTS ticket_events (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), event_type TEXT NOT NULL, actor_id TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ticket_events_page ON ticket_events(ticket_id,created_at,id);
CREATE TABLE IF NOT EXISTS ticket_reports (id TEXT PRIMARY KEY REFERENCES reports(id), ticket_id TEXT NOT NULL REFERENCES tickets(id), reported_user_id TEXT, reported_content_id TEXT, reason TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_relations (id TEXT PRIMARY KEY, source_ticket_id TEXT NOT NULL REFERENCES tickets(id), target_ticket_id TEXT NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL CHECK(relation_type IN ('RELATED','DUPLICATE','PARENT','CHILD')), created_at TEXT NOT NULL, UNIQUE(source_ticket_id,target_ticket_id,relation_type), CHECK(source_ticket_id<>target_ticket_id));
INSERT OR IGNORE INTO ticket_categories VALUES ('inquiry-account','INQUIRY','Account','account',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('inquiry-usage','INQUIRY','Usage','usage',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('inquiry-feature','INQUIRY','Feature','feature',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('inquiry-other','INQUIRY','Other','other',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('report-user','REPORT','User','user',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('report-content','REPORT','Content','content',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('report-harassment','REPORT','Harassment','harassment',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('report-spam','REPORT','Spam','spam',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('report-safety','REPORT','Safety','safety',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('report-other','REPORT','Other','other',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('bug-ui','BUG','UI','ui',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('bug-crash','BUG','Crash','crash',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('bug-data','BUG','Data','data',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('bug-authentication','BUG','Authentication','authentication',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('bug-notification','BUG','Notification','notification',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('bug-other','BUG','Other','other',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('incident-availability','INCIDENT','Availability','availability',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('incident-other','INCIDENT','Other','other',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('billing-payment','BILLING','Payment','payment',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('billing-refund','BILLING','Refund','refund',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('billing-other','BILLING','Other','other',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('privacy-access','PRIVACY','Access','access',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('privacy-erasure','PRIVACY','Erasure','erasure',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('privacy-other','PRIVACY','Other','other',1);
INSERT OR IGNORE INTO ticket_categories VALUES ('other-other','OTHER','Other','other',1);
INSERT OR IGNORE INTO service_components SELECT id || '-other',id,'Other','other',1 FROM services;
INSERT OR IGNORE INTO ticket_numbers(ticket_id) SELECT id FROM support_threads ORDER BY created_at,id;
INSERT OR IGNORE INTO ticket_numbers(ticket_id) SELECT id FROM reports WHERE support_thread_id IS NULL ORDER BY created_at,id;
INSERT OR IGNORE INTO tickets(id,ticket_number,type,status,resolution,priority,impact,urgency,service_id,subject,requester_email,created_at,updated_at,resolved_at,closed_at,sla_ack_minutes,sla_response_minutes,sla_resolution_minutes) SELECT id,(SELECT 'TK-' || printf('%06d',seq) FROM ticket_numbers WHERE ticket_id=t.id),'INQUIRY', CASE status WHEN 'pending_user' THEN 'WAITING_CUSTOMER' WHEN 'resolved' THEN 'CLOSED' WHEN 'spam' THEN 'CLOSED' ELSE 'NEW' END , CASE status WHEN 'resolved' THEN 'RESOLVED' WHEN 'spam' THEN 'SPAM' ELSE NULL END ,'P3','MEDIUM','MEDIUM',COALESCE(app_id,'studio'),subject,NULLIF(requester_email,''),created_at,updated_at,resolved_at, CASE WHEN status IN ('resolved','spam') THEN COALESCE(resolved_at,updated_at) END ,480,1440,4320 FROM support_threads t;
INSERT OR IGNORE INTO ticket_sources SELECT 'support',id,id FROM support_threads;
INSERT OR IGNORE INTO tickets(id,ticket_number,type,status,resolution,priority,impact,urgency,service_id,subject,requester_email,created_at,updated_at,resolved_at,closed_at,sla_ack_minutes,sla_response_minutes,sla_resolution_minutes) SELECT id,(SELECT 'TK-' || printf('%06d',seq) FROM ticket_numbers WHERE ticket_id=r.id),'REPORT', CASE status WHEN 'reviewing' THEN 'TRIAGE' WHEN 'actioned' THEN 'RESOLVED' WHEN 'closed' THEN 'CLOSED' ELSE 'NEW' END , CASE WHEN status IN ('actioned','closed') THEN CASE resolution_code WHEN 'content_removed' THEN 'CONTENT_REMOVED' WHEN 'content_deleted' THEN 'CONTENT_REMOVED' WHEN 'no_action_required' THEN 'NO_ACTION_REQUIRED' WHEN 'no_action' THEN 'NO_ACTION_REQUIRED' ELSE 'OTHER' END END , CASE priority WHEN 'high' THEN 'P2' WHEN 'low' THEN 'P4' ELSE 'P3' END ,'MEDIUM','MEDIUM',app_id,'通報: ' || reason_code,NULL,created_at,updated_at,resolved_at, CASE WHEN status='closed' THEN COALESCE(resolved_at,updated_at) END ,480,1440,4320 FROM reports r WHERE support_thread_id IS NULL;
UPDATE tickets SET type='REPORT', assignment_group_id='moderation',
 requester_id=(SELECT r.reporter_ref_hash FROM reports r WHERE r.support_thread_id=tickets.id),
 status=(SELECT CASE r.status WHEN 'reviewing' THEN 'TRIAGE' WHEN 'actioned' THEN 'RESOLVED' WHEN 'closed' THEN 'CLOSED' ELSE 'NEW' END FROM reports r WHERE r.support_thread_id=tickets.id),
 resolution=(SELECT CASE WHEN r.status IN ('actioned','closed') THEN CASE r.resolution_code WHEN 'content_removed' THEN 'CONTENT_REMOVED' WHEN 'content_deleted' THEN 'CONTENT_REMOVED' WHEN 'no_action_required' THEN 'NO_ACTION_REQUIRED' WHEN 'no_action' THEN 'NO_ACTION_REQUIRED' ELSE 'OTHER' END END FROM reports r WHERE r.support_thread_id=tickets.id),
 resolved_at=(SELECT r.resolved_at FROM reports r WHERE r.support_thread_id=tickets.id),
 closed_at=(SELECT CASE WHEN r.status='closed' THEN COALESCE(r.resolved_at,r.updated_at) END FROM reports r WHERE r.support_thread_id=tickets.id),
 priority=(SELECT CASE r.priority WHEN 'high' THEN 'P2' WHEN 'low' THEN 'P4' ELSE 'P3' END FROM reports r WHERE r.support_thread_id=tickets.id)
 WHERE id IN (SELECT support_thread_id FROM reports r WHERE support_thread_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ticket_sources x WHERE x.source_type='report' AND x.source_id=r.id));
INSERT OR IGNORE INTO ticket_sources SELECT 'report',id,COALESCE(support_thread_id,id) FROM reports;
INSERT OR IGNORE INTO ticket_reports SELECT r.id,s.ticket_id,r.author_ref_hash,r.content_external_id,r.reason_code,r.detail,r.created_at FROM reports r JOIN ticket_sources s ON s.source_type='report' AND s.source_id=r.id;
UPDATE tickets SET impact= CASE priority WHEN 'P2' THEN 'HIGH' WHEN 'P4' THEN 'LOW' ELSE 'MEDIUM' END , urgency= CASE priority WHEN 'P4' THEN 'LOW' ELSE 'MEDIUM' END ,
 sla_ack_minutes=(SELECT ack FROM ticket_sla_settings WHERE priority=tickets.priority),sla_response_minutes=(SELECT response FROM ticket_sla_settings WHERE priority=tickets.priority),sla_resolution_minutes=(SELECT resolution FROM ticket_sla_settings WHERE priority=tickets.priority)
 WHERE NOT EXISTS(SELECT 1 FROM ticket_events e WHERE e.ticket_id=tickets.id);
INSERT OR IGNORE INTO ticket_messages SELECT m.id,s.ticket_id, CASE m.direction WHEN 'inbound' THEN 'INBOUND' ELSE 'OUTBOUND' END , CASE m.direction WHEN 'internal_note' THEN 'INTERNAL' ELSE 'PUBLIC' END ,m.sender, CASE WHEN m.direction<>'internal_note' THEN m.recipient END ,NULL,m.body_text,m.created_at,m.id, CASE WHEN EXISTS(SELECT 1 FROM support_reply_sends x WHERE x.message_id=m.id AND x.idempotency_key LIKE 'report-receipt-%') THEN 1 ELSE 0 END FROM support_messages m JOIN ticket_sources s ON s.source_type='support' AND s.source_id=m.thread_id;
UPDATE tickets SET first_response_at=(SELECT MIN(created_at) FROM ticket_messages WHERE ticket_id=tickets.id AND direction='OUTBOUND' AND visibility='PUBLIC' AND is_automatic=0) WHERE first_response_at IS NULL;
INSERT OR IGNORE INTO ticket_events SELECT 'created:' || id,id,'TICKET_CREATED',NULL,json_object('migrated',1),created_at FROM tickets;
INSERT OR IGNORE INTO ticket_events SELECT 'report:' || e.id,s.ticket_id, CASE e.event_type WHEN 'note_added' THEN 'INTERNAL_NOTE_ADDED' ELSE 'LEGACY_EVENT' END ,e.actor_id,json_object('legacyType',e.event_type,'from',e.from_status,'to',e.to_status,'note',e.note),e.created_at FROM report_events e JOIN ticket_sources s ON s.source_type='report' AND s.source_id=e.report_id;
INSERT OR IGNORE INTO ticket_events SELECT 'audit:' || a.id,s.ticket_id,'LEGACY_EVENT',a.actor_id,json_object('action',a.action,'data',json(a.metadata_json)),a.created_at FROM audit_logs a JOIN ticket_sources s ON s.source_id=a.target_id AND s.source_type= CASE a.target_type WHEN 'report' THEN 'report' ELSE 'support' END WHERE a.target_type IN ('report','support_thread');
UPDATE tickets SET status='CLOSED',resolution='DUPLICATE',merged_into=(SELECT target_thread_id FROM support_thread_redirects WHERE source_thread_id=tickets.id),closed_at=COALESCE(closed_at,updated_at) WHERE id IN (SELECT source_thread_id FROM support_thread_redirects) AND merged_into IS NULL;
INSERT OR IGNORE INTO ticket_relations SELECT 'legacy-merge:' || source_thread_id,source_thread_id,target_thread_id,'DUPLICATE',created_at FROM support_thread_redirects;

CREATE TRIGGER IF NOT EXISTS ticket_app_insert AFTER INSERT ON apps 
BEGIN
INSERT OR IGNORE INTO services VALUES (NEW.id,NEW.name,NEW.slug,1);
END;

CREATE TRIGGER IF NOT EXISTS ticket_support_insert AFTER INSERT ON support_threads 
BEGIN
INSERT OR IGNORE INTO ticket_numbers(ticket_id) VALUES(NEW.id);
INSERT OR IGNORE INTO tickets(id,ticket_number,type,status,resolution,priority,impact,urgency,service_id,subject,requester_email,created_at,updated_at,resolved_at,closed_at,sla_ack_minutes,sla_response_minutes,sla_resolution_minutes) VALUES(NEW.id,(SELECT 'TK-' || printf('%06d',seq) FROM ticket_numbers WHERE ticket_id=NEW.id),'INQUIRY','NEW',NULL,'P3','MEDIUM','MEDIUM',COALESCE(NEW.app_id,'studio'),NEW.subject,NULLIF(NEW.requester_email,''),NEW.created_at,NEW.updated_at,NULL,NULL,(SELECT ack FROM ticket_sla_settings WHERE priority='P3'),(SELECT response FROM ticket_sla_settings WHERE priority='P3'),(SELECT resolution FROM ticket_sla_settings WHERE priority='P3'));
INSERT OR IGNORE INTO ticket_sources VALUES('support',NEW.id,NEW.id);
INSERT OR IGNORE INTO ticket_events VALUES('created:' || NEW.id,NEW.id,'TICKET_CREATED',NULL,'{}',NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS ticket_report_insert AFTER INSERT ON reports WHEN NEW.support_thread_id IS NOT NULL
BEGIN
INSERT OR IGNORE INTO ticket_sources VALUES('report',NEW.id,NEW.support_thread_id);
INSERT OR IGNORE INTO ticket_reports VALUES(NEW.id,NEW.support_thread_id,NEW.author_ref_hash,NEW.content_external_id,NEW.reason_code,NEW.detail,NEW.created_at);
UPDATE tickets SET type='REPORT',assignment_group_id='moderation',requester_id=NEW.reporter_ref_hash,
 priority= CASE NEW.priority WHEN 'high' THEN 'P2' WHEN 'low' THEN 'P4' ELSE 'P3' END ,
 impact= CASE NEW.priority WHEN 'high' THEN 'HIGH' WHEN 'low' THEN 'LOW' ELSE 'MEDIUM' END ,
 urgency= CASE NEW.priority WHEN 'low' THEN 'LOW' ELSE 'MEDIUM' END
 WHERE id=NEW.support_thread_id;
UPDATE tickets SET sla_ack_minutes=(SELECT ack FROM ticket_sla_settings WHERE priority=tickets.priority),sla_response_minutes=(SELECT response FROM ticket_sla_settings WHERE priority=tickets.priority),sla_resolution_minutes=(SELECT resolution FROM ticket_sla_settings WHERE priority=tickets.priority) WHERE id=NEW.support_thread_id;

END;

CREATE TRIGGER IF NOT EXISTS ticket_report_link AFTER UPDATE OF support_thread_id ON reports WHEN OLD.support_thread_id IS NULL AND NEW.support_thread_id IS NOT NULL
BEGIN
INSERT OR IGNORE INTO ticket_sources VALUES('report',NEW.id,NEW.support_thread_id);
INSERT OR IGNORE INTO ticket_reports VALUES(NEW.id,NEW.support_thread_id,NEW.author_ref_hash,NEW.content_external_id,NEW.reason_code,NEW.detail,NEW.created_at);
UPDATE tickets SET type='REPORT',assignment_group_id='moderation',requester_id=NEW.reporter_ref_hash,
 priority= CASE NEW.priority WHEN 'high' THEN 'P2' WHEN 'low' THEN 'P4' ELSE 'P3' END ,
 impact= CASE NEW.priority WHEN 'high' THEN 'HIGH' WHEN 'low' THEN 'LOW' ELSE 'MEDIUM' END ,
 urgency= CASE NEW.priority WHEN 'low' THEN 'LOW' ELSE 'MEDIUM' END
 WHERE id=NEW.support_thread_id;
UPDATE tickets SET sla_ack_minutes=(SELECT ack FROM ticket_sla_settings WHERE priority=tickets.priority),sla_response_minutes=(SELECT response FROM ticket_sla_settings WHERE priority=tickets.priority),sla_resolution_minutes=(SELECT resolution FROM ticket_sla_settings WHERE priority=tickets.priority) WHERE id=NEW.support_thread_id;

END;

CREATE TRIGGER IF NOT EXISTS ticket_message_insert AFTER INSERT ON support_messages 
BEGIN
INSERT OR IGNORE INTO ticket_messages SELECT NEW.id,s.ticket_id, CASE NEW.direction WHEN 'inbound' THEN 'INBOUND' ELSE 'OUTBOUND' END , CASE NEW.direction WHEN 'internal_note' THEN 'INTERNAL' ELSE 'PUBLIC' END ,NEW.sender, CASE WHEN NEW.direction<>'internal_note' THEN NEW.recipient END ,NULL,NEW.body_text,NEW.created_at,NEW.id,0 FROM ticket_sources s WHERE s.source_type='support' AND s.source_id=NEW.thread_id;
INSERT OR IGNORE INTO ticket_events SELECT 'message:' || NEW.id,s.ticket_id, CASE NEW.direction WHEN 'inbound' THEN 'MESSAGE_RECEIVED' WHEN 'outbound' THEN 'MESSAGE_SENT' ELSE 'INTERNAL_NOTE_ADDED' END ,NEW.sender,json_object('messageId',NEW.id),NEW.created_at FROM ticket_sources s WHERE s.source_type='support' AND s.source_id=NEW.thread_id;
INSERT OR IGNORE INTO ticket_events SELECT 'reopen:' || NEW.id,t.id,'REOPENED',NULL,json_object('previousStatus',t.status,'newStatus','IN_PROGRESS','reason','inbound_reply'),NEW.created_at FROM tickets t JOIN ticket_sources s ON s.ticket_id=t.id WHERE s.source_type='support' AND s.source_id=NEW.thread_id AND NEW.direction='inbound' AND t.status IN ('RESOLVED','CLOSED') AND t.merged_into IS NULL;
INSERT OR IGNORE INTO ticket_events SELECT 'resume:' || NEW.id,t.id,'STATUS_CHANGED',NULL,json_object('previousStatus',t.status,'newStatus','IN_PROGRESS','reason','inbound_reply'),NEW.created_at FROM tickets t JOIN ticket_sources s ON s.ticket_id=t.id WHERE s.source_type='support' AND s.source_id=NEW.thread_id AND NEW.direction='inbound' AND t.status='WAITING_CUSTOMER';
UPDATE tickets SET updated_at=NEW.created_at,revision=revision+1,
 resolution= CASE WHEN NEW.direction='inbound' AND status IN ('RESOLVED','CLOSED') AND merged_into IS NULL THEN NULL ELSE resolution END ,
 resolved_at= CASE WHEN NEW.direction='inbound' AND status IN ('RESOLVED','CLOSED') AND merged_into IS NULL THEN NULL ELSE resolved_at END ,
 closed_at= CASE WHEN NEW.direction='inbound' AND status IN ('RESOLVED','CLOSED') AND merged_into IS NULL THEN NULL ELSE closed_at END ,
 status= CASE WHEN NEW.direction='inbound' AND status IN ('WAITING_CUSTOMER','RESOLVED','CLOSED') AND merged_into IS NULL THEN 'IN_PROGRESS' ELSE status END
 WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=NEW.thread_id);
UPDATE reports SET status='reviewing' WHERE status IN ('closed','actioned') AND NEW.direction='inbound' AND id IN (SELECT source_id FROM ticket_sources WHERE source_type='report' AND ticket_id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=NEW.thread_id)) AND EXISTS(SELECT 1 FROM tickets WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=NEW.thread_id) AND status='IN_PROGRESS' AND merged_into IS NULL);


END;

CREATE TRIGGER IF NOT EXISTS ticket_send_record AFTER INSERT ON support_reply_sends 
BEGIN
UPDATE ticket_messages SET is_automatic= CASE WHEN NEW.idempotency_key LIKE 'report-receipt-%' THEN 1 ELSE 0 END WHERE legacy_message_id=NEW.message_id;
UPDATE tickets SET first_response_at=COALESCE(first_response_at,(SELECT created_at FROM ticket_messages WHERE legacy_message_id=NEW.message_id)) WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=NEW.thread_id) AND NEW.idempotency_key NOT LIKE 'report-receipt-%';

END;

CREATE TRIGGER IF NOT EXISTS ticket_report_event AFTER INSERT ON report_events 
BEGIN
INSERT OR IGNORE INTO ticket_events SELECT 'report:' || NEW.id,s.ticket_id, CASE NEW.event_type WHEN 'note_added' THEN 'INTERNAL_NOTE_ADDED' WHEN 'resolution_updated' THEN 'REPORT_ACTION' ELSE 'LEGACY_EVENT' END ,NEW.actor_id,json_object('legacyType',NEW.event_type,'from',NEW.from_status,'to',NEW.to_status,'note',NEW.note),NEW.created_at FROM ticket_sources s WHERE s.source_type='report' AND s.source_id=NEW.report_id;

END;

CREATE TRIGGER IF NOT EXISTS ticket_report_decision AFTER UPDATE OF moderation_revision ON reports WHEN NEW.moderation_revision>OLD.moderation_revision
BEGIN
INSERT OR IGNORE INTO ticket_events SELECT 'decision:' || NEW.id || ':' || NEW.moderation_revision,id,'STATUS_CHANGED',NULL,json_object('previousStatus',status,'newStatus', CASE NEW.status WHEN 'closed' THEN 'CLOSED' ELSE 'RESOLVED' END ,'reason','signed_moderation','revision',NEW.moderation_revision),NEW.updated_at FROM tickets WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='report' AND source_id=NEW.id);
UPDATE tickets SET status= CASE NEW.status WHEN 'closed' THEN 'CLOSED' ELSE 'RESOLVED' END ,resolution= CASE NEW.resolution_code WHEN 'content_removed' THEN 'CONTENT_REMOVED' WHEN 'content_deleted' THEN 'CONTENT_REMOVED' WHEN 'no_action_required' THEN 'NO_ACTION_REQUIRED' WHEN 'no_action' THEN 'NO_ACTION_REQUIRED' ELSE 'OTHER' END ,resolved_at=NEW.resolved_at,closed_at= CASE WHEN NEW.status='closed' THEN NEW.resolved_at END ,updated_at=NEW.updated_at,revision=revision+1 WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='report' AND source_id=NEW.id);

END;
