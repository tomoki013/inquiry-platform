import type { ReplyTemplateCategory } from "@tomokichi/admin-contracts";

/**
 * Reply templates, and an honest account of where their words come from.
 *
 * **No confirmed reply wording exists anywhere in the Studio's repositories.**
 * A search across every project for the Remeet phrases, for 定型文 / reply
 * template / 返信文面, and through `apps/api`'s support and report mail
 * templates, found nothing but the notification bodies the operator receives —
 * which are not replies to anybody.
 *
 * So these templates carry exactly two kinds of text and nothing else:
 *
 * 1. The fixed phrases and the step order given in the Phase 2 instruction —
 *    the opening 「いつもRemeetをご利用いただきありがとうございます」 and the
 *    closing 「今後ともRemeetならびにTomokichi Studioをよろしくお願いいたします」.
 * 2. `{{placeholders}}` for every step whose wording was *not* given.
 *
 * The placeholders are load-bearing, not decoration. `sendSupportReply` refuses
 * a body that still contains any `{{…}}`, so a template cannot be sent until a
 * person has written the parts only they can write. That is deliberately more
 * annoying than pre-filled prose: inventing a house voice and shipping it under
 * the Studio's name is the one thing the instruction is most explicit about not
 * doing.
 *
 * `{{appName}}`, `{{userName}}` and `{{supportUrl}}` are the three that *are*
 * filled automatically — and `{{userName}}` stays unresolved when nobody typed
 * a name, which blocks the send rather than guessing one from an address.
 */
export interface ReplyTemplateSeed {
  key: string;
  name: string;
  category: ReplyTemplateCategory;
  /** Slug, resolved to an id at seed time. Absent means Studio-wide. */
  appSlug?: string;
  body: string;
  includeSignature: boolean;
  sortOrder: number;
}

export const seedReplyTemplates: ReplyTemplateSeed[] = [
  {
    key: "remeet_general_reply",
    name: "Remeet — 一般的なお問い合わせへの返信",
    category: "general",
    appSlug: "remeet",
    sortOrder: 10,
    includeSignature: true,
    body: [
      "{{userName}}様",
      "",
      "いつもRemeetをご利用いただきありがとうございます。",
      "",
      "{{answerToInquiry}}",
      "",
      "{{currentLimitations}}",
      "",
      "{{plannedImprovements}}",
      "",
      "{{thanksForFeedback}}",
      "",
      "{{welcomeFurtherQuestions}}",
      "",
      "今後ともRemeetならびにTomokichi Studioをよろしくお願いいたします。",
    ].join("\n"),
  },
  {
    key: "remeet_update_completed",
    name: "Remeet — アップデートでの改善報告",
    category: "update_completed",
    appSlug: "remeet",
    sortOrder: 20,
    includeSignature: true,
    body: [
      "{{userName}}様",
      "",
      "この度はお問い合わせいただきありがとうございます。",
      "",
      "{{referenceToPreviousInquiry}}",
      "",
      "{{whatTheUpdateImproved}}",
      "",
      "{{specificChanges}}",
      "",
      "{{remainingItemsPlannedForFutureUpdates}}",
      "",
      "{{thanksForFeedback}}",
      "",
      "{{howToUseAfterUpdating}}",
      "",
      "{{welcomeFurtherRequests}}",
      "",
      "今後ともRemeetならびにTomokichi Studioをよろしくお願いいたします。",
    ].join("\n"),
  },
];

/**
 * Categories with no template, and why.
 *
 * Reported rather than filled in. Each of these needs wording somebody has
 * actually used and stands behind; the admin screen can create them at any
 * time, and a template made there is never overwritten by re-running the seed.
 */
export const notSeededCategories: ReplyTemplateCategory[] = [
  "acknowledgement",
  "investigating",
  "need_more_information",
  "known_issue",
  "feature_request",
  "planned_update",
  "resolved",
  "purchase",
  "other",
];

/**
 * The Studio-wide signature.
 *
 * Appended by `applyReplyTemplate` when a template's `include_signature` is set
 * — once, at insert time, so what the operator reads in the composer is what
 * leaves. An app can override it in `app_mail_settings`.
 */
export const seedSignature = ["Tomokichi Studio", "https://tmkch.io"].join("\n");
