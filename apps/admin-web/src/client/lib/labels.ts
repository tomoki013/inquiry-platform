import type {
  AppLinkType,
  AppPlatform,
  AppStatus,
  ReplyTemplateCategory,
  ReportStatus,
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
