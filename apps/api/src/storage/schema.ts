/** Fixed vocabulary shared by runtime routing and the offline migration generator. */
export const storageTables = [
  "support_threads",
  "support_messages",
  "support_attachments",
  "support_drafts",
  "support_reply_sends",
  "support_reply_attempts",
  "support_thread_redirects",
  "reports",
  "report_events",
  "report_attachments",
  "report_operations",
  "tickets",
  "ticket_sources",
  "ticket_messages",
  "ticket_events",
  "ticket_reports",
  "ticket_relations",
] as const;
export type StorageTable = (typeof storageTables)[number];

// Keep the legacy SQL vocabulary inside repositories. Physical names describe
// the independent domains; cases are an operator-facing compatibility index.
export const tableSuffix: Record<StorageTable, string> = {
  support_threads: "support_tickets",
  support_messages: "support_messages",
  support_attachments: "support_attachments",
  support_drafts: "support_drafts",
  support_reply_sends: "support_reply_sends",
  support_reply_attempts: "support_reply_attempts",
  support_thread_redirects: "support_redirects",
  reports: "moderation_reports",
  report_events: "moderation_events",
  report_attachments: "moderation_evidence",
  report_operations: "moderation_operations",
  tickets: "cases",
  ticket_sources: "case_sources",
  ticket_messages: "case_messages",
  ticket_events: "case_events",
  ticket_reports: "case_reports",
  ticket_relations: "case_relations",
};

export function validatePrefix(value: string): string {
  if (!/^p_[a-z][a-z0-9_]{0,30}$/.test(value)) throw new Error("InvalidStorageIdentifier");
  return value;
}

export function tableNames(prefix: string): Record<StorageTable, string> {
  validatePrefix(prefix);
  return Object.fromEntries(
    storageTables.map((name) => [name, `${prefix}_${tableSuffix[name]}`]),
  ) as Record<StorageTable, string>;
}

/** Replace SQL identifiers, preserving quoted values, quoted identifiers and comments. */
export function rewriteIdentifiers(sql: string, names: Readonly<Record<string, string>>): string {
  return sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\b[a-zA-Z_][a-zA-Z0-9_]*\b/g,
    (token) => names[token] ?? token,
  );
}

/** Owner expression for a legacy row aliased `r`. Always use main.* here:
 * aggregate queries shadow legacy tables with read-only CTEs. */
export function ownerExpression(table: StorageTable): string {
  const threadOwner = (alias: string) =>
    `COALESCE((SELECT t.service_id FROM main.tickets t JOIN main.ticket_sources s ON s.ticket_id=t.id WHERE s.source_type='support' AND s.source_id=${alias}.id),${alias}.app_id,(SELECT value FROM platform_settings WHERE key='default_service_id'),'unassigned')`;
  switch (table) {
    case "tickets":
      return "r.service_id";
    case "reports":
      return "r.app_id";
    case "support_threads":
      return threadOwner("r");
    case "support_messages":
      return `(SELECT ${threadOwner("th")} FROM main.support_threads th WHERE th.id=r.thread_id)`;
    case "support_attachments":
      return `(SELECT ${threadOwner("th")} FROM main.support_messages m JOIN main.support_threads th ON th.id=m.thread_id WHERE m.id=r.message_id)`;
    case "support_drafts":
    case "support_reply_attempts":
    case "support_reply_sends":
      return `(SELECT ${threadOwner("th")} FROM main.support_threads th WHERE th.id=r.thread_id)`;
    case "support_thread_redirects":
      return "(SELECT service_id FROM main.tickets WHERE id=r.source_thread_id)";
    case "report_events":
    case "report_attachments":
    case "report_operations":
      return "(SELECT app_id FROM main.reports WHERE id=r.report_id)";
    case "ticket_sources":
    case "ticket_messages":
    case "ticket_events":
    case "ticket_reports":
      return "(SELECT service_id FROM main.tickets WHERE id=r.ticket_id)";
    case "ticket_relations":
      return "(SELECT service_id FROM main.tickets WHERE id=r.source_ticket_id)";
  }
}
