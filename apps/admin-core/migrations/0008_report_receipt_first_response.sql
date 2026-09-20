-- A successfully sent report receipt is the first customer-facing response.
-- Keep the automatic marker for the timeline; never infer success from a draft.
DROP TRIGGER IF EXISTS ticket_send_record;
CREATE TRIGGER ticket_send_record AFTER INSERT ON support_reply_sends
BEGIN
UPDATE ticket_messages SET is_automatic= CASE WHEN NEW.idempotency_key LIKE 'report-receipt-%' THEN 1 ELSE 0 END WHERE legacy_message_id=NEW.message_id;
UPDATE tickets SET first_response_at=COALESCE(first_response_at,(SELECT created_at FROM ticket_messages WHERE legacy_message_id=NEW.message_id)) WHERE id=(SELECT ticket_id FROM ticket_sources WHERE source_type='support' AND source_id=NEW.thread_id);
END;

-- Repair existing report tickets, including ones with a later manual reply.
-- The successful send record, rather than ticket type, identifies a receipt.
UPDATE tickets SET first_response_at=(
  SELECT MIN(m.created_at) FROM ticket_messages m
  JOIN support_reply_sends s ON s.message_id=m.legacy_message_id
  WHERE m.ticket_id=tickets.id AND s.idempotency_key LIKE 'report-receipt-%'
    AND m.direction='OUTBOUND' AND m.visibility='PUBLIC'
), revision=revision+1
WHERE EXISTS (
  SELECT 1 FROM ticket_messages m
  JOIN support_reply_sends s ON s.message_id=m.legacy_message_id
  WHERE m.ticket_id=tickets.id AND s.idempotency_key LIKE 'report-receipt-%'
    AND m.direction='OUTBOUND' AND m.visibility='PUBLIC'
    AND (tickets.first_response_at IS NULL OR m.created_at<tickets.first_response_at)
);
