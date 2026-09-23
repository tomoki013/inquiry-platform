import type { AppStatus } from "./apps";
import type { AuditEntry } from "./audit";

/**
 * The numbers on the front page, and nothing else.
 *
 * Four counts and a short activity list. Deliberately not a metrics surface:
 * analytics is Phase 4, and a Dashboard that grows a chart per release ends up
 * being the page nobody reads.
 */
export interface DashboardSummary {
  openReports: number;
  reviewingReports: number;
  openSupport: number;
  apps: { id: string; slug: string; name: string; status: AppStatus }[];
  recentActivity: AuditEntry[];
  /** False until the Support tables have anything in them, so Phase 1 can show
   * "not yet" instead of a confident zero. */
  supportConfigured: boolean;
}
