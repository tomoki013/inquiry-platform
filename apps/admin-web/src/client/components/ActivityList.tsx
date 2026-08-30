import type { AuditEntry } from "@tomokichi/admin-contracts";
import { Link } from "react-router";
import { auditActionLabel, auditActorLabel, auditTargetPath } from "../lib/labels";
import { Timestamp } from "./primitives";

/**
 * What has happened, in the order it happened.
 *
 * Shared by the Dashboard and one app's Activity tab because they were drifting
 * apart while showing the same rows out of the same table.
 *
 * Each row says the action in words and links to the thing it happened to. It
 * used to render the raw `action` in a monospace font, which is accurate — that
 * really is what is in the audit table — and useless: "somebody did
 * `support.reply_sent` to some id" is not something an operator can act on
 * without going and looking for the thread by hand.
 */
export function ActivityList({ entries }: { entries: AuditEntry[] }) {
  return (
    <ul className="divide-y divide-line-soft">
      {entries.map((entry) => {
        const path = auditTargetPath(entry);
        const label = auditActionLabel(entry.action);
        return (
          <li key={entry.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
            <span className="min-w-0">
              {path ? (
                <Link to={path} className="text-accent underline-offset-2 hover:underline">
                  {label}
                </Link>
              ) : (
                <span className="text-ink">{label}</span>
              )}
              <span className="ml-2 text-xs text-ink-faint">
                {auditActorLabel(entry.actorType)}
              </span>
            </span>
            <span className="shrink-0 text-xs text-ink-faint">
              <Timestamp value={entry.createdAt} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
