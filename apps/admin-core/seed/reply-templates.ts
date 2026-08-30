import type { ReplyTemplateCategory } from "@tomokichi/admin-contracts";

/**
 * Reply templates, in the Studio's own words.
 *
 * These replaced a set built entirely out of `{{placeholders}}`, which existed
 * because no confirmed reply wording could be found anywhere in the Studio's
 * repositories and inventing a house voice was the one thing not to do. The
 * wording here is the operator's own, supplied for exactly this purpose, so
 * the placeholders are gone from every line whose words are now known.
 *
 * What is still a placeholder is what only a person can write for one specific
 * question — the answer itself, what an update changed. `sendSupportReply`
 * refuses a body that still contains any `{{…}}`, so a template cannot go out
 * half-written.
 *
 * `{{appName}}`, `{{userName}}` and `{{supportUrl}}` are filled automatically.
 * `{{userName}}` stays unresolved when nobody typed a name, which blocks the
 * send rather than guessing one from an address.
 *
 * None of these are scoped to an app: every line that named one now says
 * `{{appName}}`, so the same three templates serve every app in the Studio.
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

const GREETING = [
  "{{userName}}様",
  "",
  "いつも{{appName}}をご利用いただきありがとうございます。",
  "Tomokichi Studioの髙木です。",
];

const CLOSING = "今後とも{{appName}}ならびにTomokichi Studioをよろしくお願いいたします。";

export const seedReplyTemplates: ReplyTemplateSeed[] = [
  {
    key: "studio_general_reply",
    name: "一般的なお問い合わせへの返信",
    category: "general",
    sortOrder: 10,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "この度はお問い合わせいただきありがとうございます。",
      "",
      // The one thing this template cannot supply. Named for what it is so the
      // composer shows 「answer」 rather than a generic marker.
      "{{answer}}",
      "",
      "ほかにも気になる点やご不明な点がございましたら、お気軽にご連絡ください。",
      "",
      CLOSING,
    ].join("\n"),
  },
  {
    key: "studio_feedback_acknowledged",
    name: "ご意見・ご要望へのお礼",
    category: "feature_request",
    sortOrder: 20,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "この度はお問い合わせいただきありがとうございます。",
      "",
      "また、{{topic}}についてのご意見をお寄せいただきありがとうございます。",
      "",
      "実際にアプリをご利用いただく中でのご意見として、今後の改善の参考にさせていただきます。",
      "",
      "ほかにも「こうなったら使いやすい」といった点や、気になる点がございましたら、お気軽にご連絡ください。",
      "",
      CLOSING,
    ].join("\n"),
  },
  {
    key: "studio_update_completed",
    name: "アップデートでの改善報告",
    category: "update_completed",
    sortOrder: 30,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "以前お問い合わせいただいた内容について、その後のアップデートで改善を行いましたのでご連絡いたしました。",
      "",
      "{{whatTheUpdateChanged}}",
      "",
      "{{whatIsStillPlanned}}",
      "",
      "この度は、実際に{{appName}}をご利用いただく中で貴重なご意見をお寄せいただき、ありがとうございました。",
      "いただいたご意見をもとに、より使いやすく改善することができました。",
      "",
      "ぜひアップデート後の{{appName}}をお試しいただけますと幸いです。",
      "ほかにも気になる点やご要望などございましたら、お気軽にご連絡ください。",
      "",
      CLOSING,
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
export const seedSignature = [
  "────────────────────────",
  "Tomokichi Studio",
  "髙木 友喜",
  "",
  "Web: https://tmkch.io",
  "Email: support@tmkch.io",
  "TEL: 080-6648-1475",
  "────────────────────────",
].join("\n");
