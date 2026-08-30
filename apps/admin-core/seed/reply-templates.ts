import type { ReplyTemplateCategory } from "@tomokichi/admin-contracts";

/**
 * Reply templates, in the Studio's own words.
 *
 * The wording is the operator's, supplied for exactly this purpose. An earlier
 * set was built almost entirely out of `{{placeholders}}` because no confirmed
 * reply wording existed anywhere in the repositories and inventing a house
 * voice was the one thing not to do; that reason is gone.
 *
 * The house rules these are written to, which are worth keeping next to the
 * text they govern:
 *
 * - A person reads and sends every reply. None of this is automatic.
 * - Nothing unverified is stated as fact.
 * - No release date is promised for anything not already shipped.
 * - A report is never contradicted — see `expected_behavior`, which explains
 *   the current behaviour without telling somebody they were wrong to ask.
 * - A follow-up goes in the same mail thread as the question it answers.
 *
 * That last rule is why a subject here is not always used. A reply to mail goes
 * out as `Re: <the thread's subject>`, which is what keeps it in the customer's
 * existing conversation, and no template overrides that. A submission from an
 * app's support form has no such conversation — the customer never sent a
 * message — and the subject the bridge invents for the row, `[category]
 * requestId`, reads as nonsense in an inbox. That is the case these subjects
 * are for. See `replySubjectFor`.
 *
 * What stays a `{{placeholder}}` is what only a person can write for one
 * specific question. `sendSupportReply` refuses a body that still contains any,
 * so a template cannot go out half-written — and a placeholder for something
 * this reply does not need is deleted rather than filled.
 *
 * `{{appName}}`, `{{userName}}` and `{{supportUrl}}` are filled automatically.
 * `{{userName}}` stays unresolved when nobody typed a name, which blocks the
 * send rather than guessing one from an address.
 *
 * None of these are scoped to an app: every line that named one says
 * `{{appName}}`, so one set serves every app in the Studio.
 */
export interface ReplyTemplateSeed {
  key: string;
  name: string;
  category: ReplyTemplateCategory;
  /** Slug, resolved to an id at seed time. Absent means Studio-wide. */
  appSlug?: string;
  /** The reply's subject, used only for a thread that has none of its own. */
  subject: string;
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
    key: "studio_general",
    subject: "お問い合わせいただいた件について",
    name: "01 通常回答",
    category: "general",
    sortOrder: 10,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "この度はお問い合わせいただきありがとうございます。",
      "",
      "{{answer}}",
      "",
      "ほかにも気になる点やご不明な点がございましたら、お気軽にご連絡ください。",
      "",
      CLOSING,
    ].join("\n"),
  },
  {
    key: "studio_bug_received",
    subject: "不具合のご報告について",
    name: "02 不具合受付",
    category: "acknowledgement",
    sortOrder: 20,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "この度は不具合についてご連絡いただきありがとうございます。",
      "ご不便をおかけして申し訳ございません。",
      "",
      "お送りいただいた内容をもとに、現在状況を確認しております。",
      "",
      // Delete this line when there is nothing yet to report. Saying nothing is
      // better than saying something not yet verified.
      "{{whatIsKnownSoFar}}",
      "",
      "確認や調査に進展がありましたら、必要に応じて改めてご連絡いたします。",
      "",
      "この度は不具合をご報告いただきありがとうございました。",
      "ほかにもお気づきの点がございましたら、お気軽にご連絡ください。",
      "",
      CLOSING,
    ].join("\n"),
  },
  {
    key: "studio_need_info",
    subject: "お問い合わせ内容について追加で確認させてください",
    name: "03 追加情報のお願い",
    category: "need_more_information",
    sortOrder: 30,
    includeSignature: true,
    // The list is literal rather than a placeholder: the operator deletes the
    // rows this particular question does not need, which is easier to get right
    // than remembering what to ask for.
    body: [
      ...GREETING,
      "",
      "お問い合わせいただいた内容について確認を進めております。",
      "",
      "より詳しく状況を確認するため、お手数ですが、可能な範囲で以下について教えていただけますでしょうか。",
      "",
      "・ご利用の端末",
      "・OSのバージョン",
      "・{{appName}}のバージョン",
      "・問題が発生するまでの操作",
      "・毎回発生するか、特定の条件でのみ発生するか",
      "・可能であればスクリーンショットや画面収録",
      "",
      "すべてをご確認いただく必要はありません。",
      "分かる範囲でお送りいただければ大丈夫です。",
      "",
      "お手数をおかけしますが、よろしくお願いいたします。",
    ].join("\n"),
  },
  {
    key: "studio_bug_fixed",
    subject: "以前ご報告いただいた不具合について",
    name: "04 不具合修正完了",
    category: "resolved",
    sortOrder: 40,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "以前ご報告いただいた不具合について、その後のアップデートで修正を行いましたのでご連絡いたしました。",
      "",
      "{{whatWasFixed}}",
      "",
      "お手数ですが、App Storeより{{appName}}を最新版へアップデートのうえ、ご確認いただけますと幸いです。",
      "",
      "この度は不具合をご報告いただきありがとうございました。",
      "いただいたご報告が、問題の発見と改善につながりました。",
      "",
      "もし最新版でも同様の問題が発生する場合や、ほかにも気になる点がございましたら、そのままこのメールへご返信ください。",
      "",
      CLOSING,
    ].join("\n"),
  },
  {
    key: "studio_expected_behavior",
    subject: "お問い合わせいただいた動作について",
    name: "05 現在の仕様",
    category: "expected_behavior",
    sortOrder: 50,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "この度はお問い合わせいただきありがとうございます。",
      "",
      "お問い合わせいただいた動作について確認したところ、現時点では不具合ではなく、現在の{{appName}}の仕様による動作となっています。",
      "",
      "{{howItWorksAndWhy}}",
      "",
      "一方で、今回お問い合わせいただいたように分かりづらく感じられる点については、今後より使いやすくできるよう改善の参考にさせていただきます。",
      "",
      "分かりづらい点があり、ご不便をおかけしました。",
      "ほかにも気になる動作やご不明な点がございましたら、お気軽にご連絡ください。",
      "",
      CLOSING,
    ].join("\n"),
  },
  {
    key: "studio_feature_request",
    subject: "機能についてのご意見ありがとうございます",
    name: "06 機能要望",
    category: "feature_request",
    sortOrder: 60,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "この度はお問い合わせいただきありがとうございます。",
      "",
      "また、{{requestedFeature}}についてのご意見をお寄せいただきありがとうございます。",
      "",
      "実際に{{appName}}をご利用いただく中でのご意見として、今後の改善を検討する際の参考にさせていただきます。",
      "",
      // Delete when no explanation of the current behaviour is needed.
      "{{currentBehaviourIfNeeded}}",
      "",
      "現時点では追加時期などをお約束することはできませんが、より使いやすいアプリにしていくための大切なご意見として受け取っております。",
      "",
      "ほかにも「こうなったら使いやすい」といった点や、気になる点がございましたら、お気軽にご連絡ください。",
      "",
      CLOSING,
    ].join("\n"),
  },
  {
    key: "studio_feature_released",
    subject: "以前ご要望いただいた機能について",
    name: "07 要望した機能の実装報告",
    category: "update_completed",
    sortOrder: 70,
    includeSignature: true,
    body: [
      ...GREETING,
      "",
      "以前お問い合わせいただいた{{requestedFeature}}について、その後のアップデートで改善を行いましたのでご連絡いたしました。",
      "",
      "今回のアップデートにより、{{whatWasAdded}}。",
      "",
      "{{howItHelps}}",
      "",
      "この度は、実際に{{appName}}をご利用いただく中で貴重なご意見をお寄せいただき、ありがとうございました。",
      "いただいたご意見をもとに、より使いやすく改善することができました。",
      "",
      "ぜひアップデート後の{{appName}}をお試しいただけますと幸いです。",
      "実際にお使いいただいて気になる点や、ほかにもご要望などございましたら、そのままこのメールへお気軽にご返信ください。",
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
  "investigating",
  "known_issue",
  "planned_update",
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
