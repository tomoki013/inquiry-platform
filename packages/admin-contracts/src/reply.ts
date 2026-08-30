import { z } from "zod";
import type { SupportSource } from "./support";

/**
 * Replying to a support thread from the admin screen.
 *
 * Three rules shape this file, and they are all about not losing or misdirecting
 * somebody's words:
 *
 * 1. **The browser never says who the mail goes to.** `sendSupportReply` takes a
 *    thread id and a body. Recipient, sender, subject and the threading headers
 *    are built in Admin Core from the thread — a tampered request cannot
 *    redirect a reply.
 * 2. **A draft outlives everything except a successful send.** Autosaved,
 *    restored on reopen, and deleted only after the provider has accepted the
 *    mail. A failed send keeps it.
 * 3. **An internal note is a different method, not a flag.** See
 *    `AdminCoreApi.addSupportMessage` and `sendSupportReply`: there is no
 *    parameter that turns one into the other, because a boolean that decides
 *    whether a private note gets emailed to a customer is one typo away from
 *    the worst bug this system could have.
 */

/** Classification only — not every category needs a template to exist. */
export const replyTemplateCategories = [
  "general",
  "acknowledgement",
  "investigating",
  "need_more_information",
  "known_issue",
  /** Working as intended, and said so. Distinct from `known_issue`, which
   * concedes a problem: answering "that is the current behaviour" as though it
   * were a known fault is a different thing to tell somebody. */
  "expected_behavior",
  "feature_request",
  "planned_update",
  "resolved",
  "update_completed",
  "purchase",
  "other",
] as const;
export type ReplyTemplateCategory = (typeof replyTemplateCategories)[number];

/**
 * The only substitutions a template may contain.
 *
 * Small on purpose. `userName` is filled **only** from a name the person typed
 * into the support form — never derived from the address, because
 * `tomoki123@example.com` is not evidence that anybody is called Tomoki, and
 * guessing it into a greeting is worse than having no greeting.
 */
export const replyTemplateVariables = ["appName", "userName", "supportUrl"] as const;
export type ReplyTemplateVariable = (typeof replyTemplateVariables)[number];

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** Every `{{name}}` still standing in a body, in order of appearance. */
export function unresolvedVariables(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * Fills what it can and leaves the rest standing.
 *
 * Leaving `{{userName}}` visible is deliberate: `sendSupportReply` refuses a
 * body that still contains one, so an unknown name stops the mail instead of
 * shipping a literal `{{userName}}` to a customer.
 */
export function renderTemplate(
  body: string,
  values: Partial<Record<ReplyTemplateVariable, string | undefined>>,
): string {
  return body.replace(VARIABLE_PATTERN, (whole, name: string) => {
    const value = values[name as ReplyTemplateVariable];
    return typeof value === "string" && value.length > 0 ? value : whole;
  });
}

/**
 * `Re:` once, however many round trips the thread has had.
 *
 * Matches the English and Japanese prefixes mail clients actually produce, with
 * or without a `[n]` counter, so a subject that has been round-tripped through
 * Gmail and a Japanese client does not accumulate a column of them.
 */
const REPLY_PREFIX = /^\s*(?:(?:re|aw|sv|antw|回信|답장)(?:\s*\[\d+\])?\s*[:：]\s*|Re[:：]\s*)+/i;

export function replySubject(subject: string): string {
  const stripped = subject.replace(REPLY_PREFIX, "").trim();
  return stripped.length === 0 ? "Re:" : `Re: ${stripped}`;
}

/** Used when a thread has no subject of its own and no template chose one. */
export const DEFAULT_REPLY_SUBJECT = "お問い合わせいただいた件について";

/**
 * The subject a reply actually goes out with.
 *
 * For mail, `Re: <what they wrote>`. Echoing their subject is what keeps the
 * answer in the conversation they started, so it is not something a template
 * gets to override — a follow-up that starts a second thread is the problem
 * this avoids, not a formatting preference.
 *
 * A form submission is the opposite case: there is no message of theirs to
 * reply to, because they never sent one. `admin-bridge.ts` still needs a
 * subject for the row and builds `[category] requestId`, which is fine as a
 * heading in the admin screen and reads as `Re: [bug] 8f21c…` in a customer's
 * inbox — meaningless, and obviously machine-made. With no thread to preserve,
 * the subject is chosen rather than echoed: the template's, when one was used,
 * and a plain default otherwise.
 */
export function replySubjectFor(
  thread: { subject: string; source: SupportSource },
  templateSubject?: string,
): string {
  if (thread.source === "email") return replySubject(thread.subject);
  const chosen = templateSubject?.trim();
  return chosen && chosen.length > 0 ? chosen : DEFAULT_REPLY_SUBJECT;
}

// ---- Templates ----------------------------------------------------------

export interface ReplyTemplate {
  id: string;
  /** Stable handle a seed can re-run against. Never changes. */
  key: string;
  name: string;
  category: ReplyTemplateCategory;
  /** `undefined` means the template belongs to the Studio, not one app. */
  appId?: string;
  appSlug?: string;
  /** Offered as the reply's subject, and used only when the thread has none of
   * its own — see `replySubjectFor`. Absent means the default is used. */
  subject?: string;
  body: string;
  /** Whether the app's signature is appended when this template is inserted.
   * A column rather than a search for the signature's text in the body: a
   * template that happens to quote part of the sign-off must not silently lose
   * its real one. */
  includeSignature: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export const TEMPLATE_BODY_LIMIT = 20_000;
const SUBJECT_LIMIT = 200;

export const createReplyTemplateInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, "lowercase words joined by underscores"),
  name: z.string().trim().min(1).max(160),
  category: z.enum(replyTemplateCategories),
  appId: z.string().min(1).optional(),
  subject: z.string().trim().max(SUBJECT_LIMIT).optional(),
  body: z.string().min(1).max(TEMPLATE_BODY_LIMIT),
  includeSignature: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type CreateReplyTemplateInput = z.infer<typeof createReplyTemplateInputSchema>;

export const updateReplyTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  category: z.enum(replyTemplateCategories).optional(),
  /** `null` moves the template back to the Studio-wide scope. */
  appId: z.string().min(1).nullable().optional(),
  /** `null` clears it, which puts the default back. */
  subject: z.string().trim().max(SUBJECT_LIMIT).nullable().optional(),
  body: z.string().min(1).max(TEMPLATE_BODY_LIMIT).optional(),
  includeSignature: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type UpdateReplyTemplateInput = z.infer<typeof updateReplyTemplateInputSchema>;

export const listReplyTemplatesInputSchema = z
  .object({
    /** Narrows to this app's templates plus the Studio-wide ones — what the
     * composer shows while a thread is open. */
    forAppId: z.string().min(1).optional(),
    includeInactive: z.boolean().default(false),
  })
  .default({ includeInactive: false });
export type ListReplyTemplatesInput = z.infer<typeof listReplyTemplatesInputSchema>;

export const applyTemplateInputSchema = z.object({
  threadId: z.string().min(1),
  templateId: z.string().min(1),
});
export type ApplyTemplateInput = z.infer<typeof applyTemplateInputSchema>;

export interface AppliedTemplate {
  /** The body as it would be sent: variables filled, signature already appended
   * if the template asked for one. Nothing is added at send time, so what the
   * operator reads in the box is what leaves. */
  bodyText: string;
  /** Still standing after rendering. A non-empty list blocks sending. */
  unresolved: string[];
  /** What the reply's subject becomes if this template is the one sent. Already
   * resolved against the thread, so the composer can show it rather than
   * guessing at the rule. */
  subject: string;
}

// ---- Drafts -------------------------------------------------------------

export interface SupportDraft {
  threadId: string;
  bodyText: string;
  updatedAt: string;
}

export const saveSupportDraftInputSchema = z.object({
  threadId: z.string().min(1),
  bodyText: z.string().max(TEMPLATE_BODY_LIMIT),
});
export type SaveSupportDraftInput = z.infer<typeof saveSupportDraftInputSchema>;

// ---- Sending ------------------------------------------------------------

export const sendSupportReplyInputSchema = z.object({
  threadId: z.string().min(1),
  bodyText: z.string().trim().min(1).max(TEMPLATE_BODY_LIMIT),
  /** Minted by the browser once per composed reply and reused across retries.
   * Backend-enforced: a double-clicked button, or a retried fetch, produces one
   * mail. */
  idempotencyKey: z.string().trim().min(8).max(200),
  /** Required to reply into a thread somebody had marked resolved — the UI asks
   * first, and sending reopens it. */
  reopenIfResolved: z.boolean().default(false),
  /** The template the operator inserted, if any. An **id**, never a subject:
   * Admin Core looks the subject up itself, so the rule about what a browser
   * may decide — a body and nothing else — still holds. */
  templateId: z.string().min(1).optional(),
});
export type SendSupportReplyInput = z.infer<typeof sendSupportReplyInputSchema>;

// ---- Signatures ---------------------------------------------------------

export interface AppMailSettings {
  /** `undefined` is the Studio-wide default, used by any app with none of its
   * own and by threads not linked to an app. */
  appId?: string;
  signatureText: string;
  updatedAt: string;
}

export const setAppMailSettingsInputSchema = z.object({
  appId: z.string().min(1).nullable(),
  signatureText: z.string().max(2000),
});
export type SetAppMailSettingsInput = z.infer<typeof setAppMailSettingsInputSchema>;
