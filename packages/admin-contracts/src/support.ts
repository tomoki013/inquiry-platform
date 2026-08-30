import { z } from "zod";

/**
 * Support conversations.
 *
 * A thread is a person and a subject; messages hang off it in both directions
 * plus a third that never leaves the building. `internal_note` shares the
 * message table rather than getting its own so that the timeline is one ordered
 * list — and the send path checks the direction rather than the caller
 * remembering which table to write to.
 */
export const supportSources = ["email", "web_form", "internal"] as const;
export type SupportSource = (typeof supportSources)[number];

export const supportStatuses = ["open", "pending_user", "resolved", "spam"] as const;
export type SupportStatus = (typeof supportStatuses)[number];

export const supportDirections = ["inbound", "outbound", "internal_note"] as const;
export type SupportDirection = (typeof supportDirections)[number];

/** Every status can reach every other one: a thread marked spam by mistake has
 * to be recoverable, and "resolved" is not a one-way door when somebody
 * replies. Reports are the opposite case, and are constrained. */
export function canTransitionSupport(from: SupportStatus, to: SupportStatus): boolean {
  return from !== to && supportStatuses.includes(to);
}

export const SUPPORT_BODY_LIMIT = 100_000;
export const SUPPORT_SUBJECT_LIMIT = 500;

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => {
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    })
    .optional();

const email = z.string().trim().email().max(320);

export const createSupportThreadInputSchema = z.object({
  appSlug: z.string().min(1).max(64).optional(),
  source: z.enum(supportSources),
  requesterEmail: email,
  /** Only ever a name the person typed themselves. Never derived from the
   * address — see `replyTemplateVariables` in `reply.ts`. */
  requesterName: optionalText(120),
  subject: z.string().trim().max(SUPPORT_SUBJECT_LIMIT).default("(件名なし)"),
  /** The first message. A thread with no message is not a thing anybody wants
   * to look at, so the two are created together. */
  bodyText: z.string().max(SUPPORT_BODY_LIMIT),
  providerMessageId: optionalText(998),
  inReplyTo: optionalText(998),
  sender: optionalText(320),
  recipient: optionalText(320),
  createdAt: z.iso.datetime().optional(),
});
export type CreateSupportThreadInput = z.infer<typeof createSupportThreadInputSchema>;

export const createSupportMessageInputSchema = z.object({
  threadId: z.string().min(1),
  direction: z.enum(supportDirections),
  bodyText: z.string().max(SUPPORT_BODY_LIMIT),
  providerMessageId: optionalText(998),
  inReplyTo: optionalText(998),
  sender: optionalText(320),
  recipient: optionalText(320),
  createdAt: z.iso.datetime().optional(),
});
export type CreateSupportMessageInput = z.infer<typeof createSupportMessageInputSchema>;

/**
 * What the mail Worker hands over: one already-parsed inbound message that may
 * or may not belong to a thread that exists.
 */
export const ingestInboundEmailInputSchema = z.object({
  from: email,
  to: optionalText(320),
  subject: z.string().max(SUPPORT_SUBJECT_LIMIT).default(""),
  /** Plain text only. HTML is flattened in the mail Worker, before it gets
   * here, so nothing downstream has to decide whether to trust it. */
  bodyText: z.string().max(SUPPORT_BODY_LIMIT),
  messageId: optionalText(998),
  inReplyTo: optionalText(998),
  /** `References`, newest last, as the header lists them. */
  references: z.array(z.string().max(998)).max(50).default([]),
  requesterName: optionalText(120),
  appSlug: z.string().min(1).max(64).optional(),
  receivedAt: z.iso.datetime().optional(),
});
export type IngestInboundEmailInput = z.infer<typeof ingestInboundEmailInputSchema>;

export const setSupportStatusInputSchema = z.object({
  threadId: z.string().min(1),
  status: z.enum(supportStatuses),
});
export type SetSupportStatusInput = z.infer<typeof setSupportStatusInputSchema>;

export const assignSupportAppInputSchema = z.object({
  threadId: z.string().min(1),
  /** `null` unlinks the thread from every app. */
  appId: z.string().min(1).nullable(),
});
export type AssignSupportAppInput = z.infer<typeof assignSupportAppInputSchema>;

export const replySupportInputSchema = z.object({
  threadId: z.string().min(1),
  bodyText: z.string().trim().min(1).max(SUPPORT_BODY_LIMIT),
});
export type ReplySupportInput = z.infer<typeof replySupportInputSchema>;

export const listSupportThreadsInputSchema = z
  .object({
    appId: z.string().min(1).optional(),
    status: z.enum(supportStatuses).optional(),
    query: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .default({ limit: 50, offset: 0 });
export type ListSupportThreadsInput = z.infer<typeof listSupportThreadsInputSchema>;

export interface SupportThreadSummary {
  id: string;
  appId?: string;
  appSlug?: string;
  appName?: string;
  source: SupportSource;
  requesterEmail: string;
  requesterName?: string;
  subject: string;
  status: SupportStatus;
  unreadCount: number;
  lastMessageAt: string;
  updatedAt: string;
  createdAt: string;
}

export interface SupportMessage {
  id: string;
  threadId: string;
  direction: SupportDirection;
  sender?: string;
  recipient?: string;
  bodyText: string;
  createdAt: string;
  attachments: SupportAttachmentMeta[];
}

export interface SupportAttachmentMeta {
  id: string;
  messageId: string;
  originalFilename?: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
}

export interface SupportThreadDetail extends SupportThreadSummary {
  resolvedAt?: string;
  messages: SupportMessage[];
}

export interface SupportThreadListPage {
  items: SupportThreadSummary[];
  total: number;
}

export interface IngestInboundEmailResult {
  threadId: string;
  messageId: string;
  /** True when the same `Message-ID` had already been stored — the mail
   * platform retried, and this is not a second message. */
  duplicate: boolean;
  newThread: boolean;
}
