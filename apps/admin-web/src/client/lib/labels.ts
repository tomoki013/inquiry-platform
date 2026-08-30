import type {
  AppLinkType,
  AppPlatform,
  AppStatus,
  AuditActorType,
  AuditEntry,
  AuditTargetType,
  ReplyTemplateCategory,
  ReportStatus,
  SupportSource,
  SupportStatus,
} from "@tomokichi/admin-contracts";

/**
 * The screen's Japanese, in one file.
 *
 * The contracts keep their English identifiers — they are the wire format, the
 * column values and the audit log, and translating those would be translating
 * data. What gets translated is the word a person reads, and it is collected
 * here rather than spelled out at each `<option>` so that "actioned" cannot end
 * up as 「対応記録済み」 on one screen and 「対応済み」 on the next.
 *
 * `labelFor` falls back to the raw value: a status added to the contracts and
 * not yet translated shows up as itself, which is ugly and obvious, rather than
 * as an empty cell.
 */

export const reportStatusLabels: Record<ReportStatus, string> = {
  open: "未対応",
  reviewing: "確認中",
  actioned: "対応記録済み",
  closed: "クローズ",
};

export const supportStatusLabels: Record<SupportStatus, string> = {
  open: "未対応",
  pending_user: "返信待ち",
  resolved: "解決済み",
  spam: "迷惑メール",
};

export const appStatusLabels: Record<AppStatus, string> = {
  development: "開発中",
  testflight: "TestFlight",
  review: "審査中",
  live: "公開中",
  paused: "停止中",
  retired: "提供終了",
};

export const appPlatformLabels: Record<AppPlatform, string> = {
  ios: "iOS",
  web: "Web",
  "ios-web": "iOS・Web",
};

export const appLinkTypeLabels: Record<AppLinkType, string> = {
  brand: "ブランドサイト",
  support: "サポート",
  privacy: "プライバシーポリシー",
  terms: "利用規約",
  app_store: "App Store",
  github: "GitHub",
  backend: "バックエンド",
  other: "その他",
};

export const replyTemplateCategoryLabels: Record<ReplyTemplateCategory, string> = {
  general: "一般",
  acknowledgement: "受付連絡",
  investigating: "調査中",
  need_more_information: "追加情報のお願い",
  known_issue: "既知の問題",
  feature_request: "機能のご要望",
  planned_update: "対応予定",
  resolved: "解決済み",
  update_completed: "対応完了",
  purchase: "購入・課金",
  other: "その他",
};

/**
 * Every status this application shows, in one map.
 *
 * Report and support statuses overlap on `open` and `resolved`, and they mean
 * the same thing in both places, so `StatusPill` can look a status up without
 * being told which kind it is.
 */
const allStatusLabels: Record<string, string> = {
  ...reportStatusLabels,
  ...supportStatusLabels,
  ...appStatusLabels,
};

export function statusLabel(status: string): string {
  return allStatusLabels[status] ?? status;
}

export function labelFor(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value;
}

/**
 * What each audited action was, said as a person would say it.
 *
 * The stored `action` is a stable identifier — `support.reply_sent` is what is
 * in the table forever and what a query filters on — so it is translated for
 * display and never at the point it is written. An action added to Admin Core
 * and not yet listed here falls through to its identifier, which is how the
 * activity list stays honest about something having happened rather than
 * dropping the row.
 */
export const auditActionLabels: Record<string, string> = {
  "app.created": "アプリを追加",
  "app.updated": "アプリを更新",
  "app.link_added": "リンクを追加",
  "app.link_removed": "リンクを削除",
  "mail_settings.updated": "メール設定を更新",
  "reply_template.created": "定型文を追加",
  "reply_template.updated": "定型文を更新",
  "reply_template.deactivated": "定型文を停止",
  "report.created": "通報を受信",
  "report.note_added": "通報にメモを追加",
  "report.resolution_updated": "通報の対応を記録",
  "support.received": "問い合わせを受信",
  "support.reply_sent": "返信を送信",
  "support.status_changed": "問い合わせのステータスを変更",
  "support.app_assigned": "問い合わせのアプリを設定",
  "support.internal_note_added": "問い合わせに運営メモを追加",
};

export const auditActorLabels: Record<AuditActorType, string> = {
  admin: "運営",
  system: "システム",
  app: "アプリ",
  email: "メール",
};

export function auditActionLabel(action: string): string {
  return auditActionLabels[action] ?? action;
}

export function auditActorLabel(actorType: AuditActorType): string {
  return auditActorLabels[actorType] ?? actorType;
}

/**
 * Where an activity row points.
 *
 * `system` targets — templates, mail settings — have no screen of their own, so
 * they get no link rather than a link to nowhere.
 */
const auditTargetPaths: Record<AuditTargetType, ((id: string) => string) | null> = {
  report: (id) => `/reports/${id}`,
  support_thread: (id) => `/support/${id}`,
  app: (id) => `/apps/${id}`,
  system: null,
};

export function auditTargetPath(entry: Pick<AuditEntry, "targetType" | "targetId">): string | null {
  const build = auditTargetPaths[entry.targetType];
  return build && entry.targetId ? build(entry.targetId) : null;
}

export const supportSourceLabels: Record<SupportSource, string> = {
  email: "メール",
  web_form: "アプリの問い合わせフォーム",
  internal: "運営が作成",
};

/**
 * The shape `apps/api` gives a form submission when it hands one to Admin.
 *
 * `admin-bridge.ts` has no subject to pass on — a form has a category and a
 * request id and no subject line — so it builds one as `[category] requestId`.
 * That is fine as a subject and unreadable as a heading, so the two halves are
 * pulled back apart for display here.
 *
 * Display only. The stored subject is untouched: it is what a reply quotes and
 * what somebody searching for a request id will match on. A subject that does
 * not have this shape — every real email — is returned as itself.
 */
export function splitFormSubject(subject: string): {
  category?: string;
  requestId?: string;
  rest: string;
} {
  const match = /^\[([^\]]+)\]\s*(\S+)\s*$/.exec(subject);
  if (!match?.[1] || !match[2]) return { rest: subject };
  return { category: match[1], requestId: match[2], rest: subject };
}
