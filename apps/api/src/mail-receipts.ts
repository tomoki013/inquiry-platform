import { nowIso } from "@inquiry-platform/core";
import { z } from "zod";
import { AppRepository } from "./db/apps";
import { json } from "./http";

const receiptSchema = z
  .object({
    transportId: z.uuid(),
    messageId: z
      .string()
      .max(998)
      .regex(/^<[^<>\s]+@[^<>\s]+>$/),
  })
  .strict();

/** Only a granted project's known outbound message can acquire an id. The
 * calling project verifies its provider webhook before this private RPC. */
export async function recordMailReceipt(
  db: D1Database,
  projectSlug: string,
  request: Request,
): Promise<Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 2048) return json({ error: "TOO_LARGE" }, 413);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "VALIDATION_ERROR" }, 400);
  }
  const parsed = receiptSchema.safeParse(payload);
  if (!parsed.success) return json({ error: "VALIDATION_ERROR" }, 400);
  const app = await new AppRepository(db).findBySlug(projectSlug);
  if (!app) return json({ error: "NOT_FOUND" }, 404);
  const row = await db
    .prepare(
      `SELECT m.id, m.provider_message_id FROM support_messages m
     JOIN support_threads t ON t.id=m.thread_id
     WHERE t.app_id=? AND m.direction='outbound' AND m.transport_id=?`,
    )
    .bind(app.id, parsed.data.transportId)
    .first<{ id: string; provider_message_id: string | null }>();
  if (!row) return json({ error: "NOT_FOUND" }, 404);
  if (row.provider_message_id && row.provider_message_id !== parsed.data.messageId)
    return json({ error: "CONFLICT" }, 409);
  try {
    const saved = await db
      .prepare(
        `UPDATE support_messages SET provider_message_id=?, message_id_checked_at=?
       WHERE id=? AND (provider_message_id IS NULL OR provider_message_id=?)`,
      )
      .bind(parsed.data.messageId, nowIso(), row.id, parsed.data.messageId)
      .run();
    if (saved.meta.changes !== 1) return json({ error: "CONFLICT" }, 409);
    return json({ recorded: true }, 200);
  } catch {
    // No payload or recipient is logged on a conflicting provider receipt.
    return json({ error: "CONFLICT" }, 409);
  }
}
