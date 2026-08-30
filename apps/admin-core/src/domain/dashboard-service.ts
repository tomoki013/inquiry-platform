import type { DashboardSummary, Result } from "@tomokichi/admin-contracts";
import { ok } from "@tomokichi/admin-contracts";
import type { AppRepository } from "../db/apps";
import type { AuditRepository } from "../db/audit";
import type { ReportRepository } from "../db/reports";
import type { SupportRepository } from "../db/support";
import { internalFailure } from "./failures";

/**
 * The front page.
 *
 * Four numbers, the app list and the last few things that happened. No charts,
 * no trends, no ratios: Phase 1–3 has nothing to plot that would change what an
 * operator does next, and a dashboard full of numbers nobody acts on is a
 * dashboard nobody reads.
 */
export class DashboardService {
  constructor(
    private readonly reports: ReportRepository,
    private readonly support: SupportRepository,
    private readonly apps: AppRepository,
    private readonly audit: AuditRepository,
  ) {}

  async summary(): Promise<Result<DashboardSummary>> {
    try {
      const [openReports, reviewingReports, openSupport, totalSupport, apps, recentActivity] =
        await Promise.all([
          this.reports.countByStatus("open"),
          this.reports.countByStatus("reviewing"),
          this.support.countOpen(),
          this.support.countAll(),
          this.apps.listSummaries(false),
          this.audit.list({ limit: 12, offset: 0 }),
        ]);

      return ok({
        openReports,
        reviewingReports,
        openSupport,
        apps: apps.map((app) => ({
          id: app.id,
          slug: app.slug,
          name: app.name,
          status: app.status,
        })),
        recentActivity,
        // Before any mail has ever arrived, "0 open" is a confident claim about
        // a feature that is not wired up yet. The Dashboard says "—" instead.
        supportConfigured: totalSupport > 0,
      });
    } catch (error) {
      return internalFailure("dashboard.summary", error);
    }
  }
}
