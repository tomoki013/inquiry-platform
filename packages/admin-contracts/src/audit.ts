import { z } from "zod";

/**
 * Who did what to which record.
 *
 * `metadata` exists for ids, codes and counts. It must never carry a message
 * body, a photo, an email address in full, a token or a header — the audit log
 * is the one table that is never pruned, and anything put in it is kept
 * forever. `assertSafeAuditMetadata` is the guard, and it is enforced in Admin
 * Core rather than left to whoever writes the next call site.
 */
export const auditActorTypes = ["admin", "system", "app", "email"] as const;
export type AuditActorType = (typeof auditActorTypes)[number];

export const auditTargetTypes = ["report", "support_thread", "app", "system"] as const;
export type AuditTargetType = (typeof auditTargetTypes)[number];

export interface AuditEntry {
  id: string;
  actorType: AuditActorType;
  actorId?: string;
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  metadata: Record<string, string | number | boolean>;
  createdAt: string;
}

export const listAuditInputSchema = z
  .object({
    targetType: z.enum(auditTargetTypes).optional(),
    targetId: z.string().min(1).optional(),
    /** Everything touching one app: its own row, plus its reports and threads.
     * Resolved by Admin Core, which is the only place that knows the joins. */
    appId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .default({ limit: 50, offset: 0 });
export type ListAuditInput = z.infer<typeof listAuditInputSchema>;

/** Keys whose *value* is content rather than a reference. Rejected outright so
 * a future call site cannot quietly start logging a message body. */
const forbiddenMetadataKeys = new Set([
  "body",
  "bodytext",
  "text",
  "message",
  "snapshot",
  "snapshottext",
  "detail",
  "note",
  "email",
  "requesteremail",
  "sender",
  "recipient",
  "photo",
  "image",
  "token",
  "jwt",
  "authorization",
  "cookie",
  "secret",
  "apikey",
  "password",
]);

export function assertSafeAuditMetadata(metadata: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (forbiddenMetadataKeys.has(key.toLowerCase().replace(/[^a-z]/g, ""))) {
      throw new Error(`audit metadata may not carry "${key}"`);
    }
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new Error(`audit metadata "${key}" must be a scalar`);
    }
    // A short scalar is an id, a code or a count. Anything longer is prose that
    // somebody meant to put in a note.
    if (type === "string" && (value as string).length > 200) {
      throw new Error(`audit metadata "${key}" is too long to be a reference`);
    }
  }
}
