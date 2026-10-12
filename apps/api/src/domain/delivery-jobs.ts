import type {
  ActorRef,
  OperatorDeliveryJob,
  OperatorDeliveryPage,
  Result,
} from "@inquiry-platform/core";
import { fail, newId, ok } from "@inquiry-platform/core";
import type { Scope } from "./scope";

export type JobKind = OperatorDeliveryJob["kind"];
export interface JobRow {
  id: string;
  service_id: string;
  project_name?: string;
  kind: JobKind;
  state: OperatorDeliveryJob["state"];
  payload: string;
  attempts: number;
  generation: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}
export class DeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function jobView(row: JobRow): OperatorDeliveryJob {
  return {
    id: row.id,
    projectId: row.service_id,
    ...(row.project_name ? { projectName: row.project_name } : {}),
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
const MAX_ATTEMPTS = 8;
const LEASE_MS = 10 * 60_000;
export class DeliveryJobs {
  constructor(
    private readonly db: D1Database,
    private readonly perform: (row: JobRow) => Promise<(() => Promise<void>) | void>,
    private readonly clock: () => number = Date.now,
  ) {}
  statement(id: string, serviceId: string, kind: JobKind, payload: unknown): D1PreparedStatement {
    const at = new Date(this.clock()).toISOString();
    return this.db
      .prepare(
        `INSERT OR IGNORE INTO delivery_jobs(id,service_id,kind,payload,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
      )
      .bind(id, serviceId, kind, JSON.stringify(payload), at, at, at);
  }
  notificationStatements(ref: {
    ticketId: string;
    category: string;
    channels?: { email?: boolean; push?: boolean };
  }): D1PreparedStatement[] {
    const at = new Date(this.clock()).toISOString();
    return (["email", "push"] as const)
      .filter((channel) => ref.channels?.[channel] !== false)
      .map((channel) =>
        this.db
          .prepare(`INSERT OR IGNORE INTO delivery_jobs(id,service_id,kind,payload,next_attempt_at,created_at,updated_at)
   SELECT ?,service_id,?,?, ?,?,? FROM tickets WHERE id=?`)
          .bind(
            `notify-${channel}-${ref.ticketId}`,
            `notification_${channel}`,
            JSON.stringify({ ticketId: ref.ticketId, category: ref.category }),
            at,
            at,
            at,
            ref.ticketId,
          ),
      );
  }
  async enqueueNotification(ref: {
    ticketId: string;
    category: string;
    channels?: { email?: boolean; push?: boolean };
  }): Promise<void> {
    const statements = this.notificationStatements(ref);
    if (statements.length) await this.db.batch(statements);
    for (const channel of ["email", "push"])
      if (ref.channels?.[channel as "email" | "push"] !== false)
        await this.run(`notify-${channel}-${ref.ticketId}`);
  }
  async run(id: string): Promise<boolean> {
    const now = this.clock(),
      at = new Date(now).toISOString(),
      token = newId();
    const exhausted = await this.db
      .prepare(
        `UPDATE delivery_jobs SET state='failed',last_error='LEASE_EXPIRED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state='running' AND lease_until<=? AND attempts>=? RETURNING *`,
      )
      .bind(at, id, at, MAX_ATTEMPTS)
      .first<JobRow>();
    if (exhausted) {
      if (exhausted.kind !== "failure_alert")
        await this.statement(
          `alert-${id}-${exhausted.generation}`,
          exhausted.service_id,
          "failure_alert",
          { jobId: id, generation: exhausted.generation },
        ).run();
      return true;
    }
    const row = await this.db
      .prepare(`UPDATE delivery_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?
    WHERE id=? AND ((state='queued' AND next_attempt_at<=?) OR (state='running' AND lease_until<=?))
    RETURNING *`)
      .bind(token, new Date(now + LEASE_MS).toISOString(), at, id, at, at)
      .first<JobRow>();
    if (!row) return false;
    try {
      const cleanup = await this.perform(row);
      const done = await this.db
        .prepare(
          `UPDATE delivery_jobs SET state='completed',payload='{}',last_error=NULL,lease_token=NULL,lease_until=NULL,completed_at=?,updated_at=? WHERE id=? AND lease_token=?`,
        )
        .bind(at, at, id, token)
        .run();
      if (done.meta.changes && cleanup) await cleanup().catch(() => undefined);
    } catch (error) {
      const code =
        error instanceof DeliveryError && /^[A-Z_]{1,64}$/.test(error.code)
          ? error.code
          : "INTERNAL_ERROR";
      const next = new Date(now + Math.min(60, 2 ** (row.attempts - 1)) * 60_000).toISOString();
      const failed = await this.db
        .prepare(
          `UPDATE delivery_jobs SET state=?,last_error=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?`,
        )
        .bind(
          row.attempts >= MAX_ATTEMPTS || code === "MAIL_EXPIRED" ? "failed" : "queued",
          code,
          next,
          at,
          id,
          token,
        )
        .run();
      if (failed.meta.changes && row.kind !== "failure_alert") {
        await this.statement(`alert-${id}-${row.generation}`, row.service_id, "failure_alert", {
          jobId: id,
          generation: row.generation,
        }).run();
      }
      console.log(
        JSON.stringify({ event: "delivery.failed", kind: row.kind, code, attempt: row.attempts }),
      );
    }
    return true;
  }
  async drain(): Promise<void> {
    const at = new Date(this.clock()).toISOString();
    // Recover an alert intent if a Worker stopped after recording the failure.
    await this.db
      .prepare(`INSERT OR IGNORE INTO delivery_jobs(id,service_id,kind,payload,next_attempt_at,created_at,updated_at)
      SELECT 'alert-'||id||'-'||generation,service_id,'failure_alert',json_object('jobId',id,'generation',generation),?,?,?
      FROM delivery_jobs WHERE kind<>'failure_alert' AND state<>'completed' AND last_error IS NOT NULL`)
      .bind(at, at, at)
      .run();
    const rows = await this.db
      .prepare(
        `SELECT id FROM delivery_jobs WHERE (state='queued' AND next_attempt_at<=?) OR (state='running' AND lease_until<=?) ORDER BY next_attempt_at LIMIT 25`,
      )
      .bind(at, at)
      .all<{ id: string }>();
    for (const row of rows.results) await this.run(row.id);
  }
  async list(scope: Scope): Promise<Result<OperatorDeliveryPage>> {
    const scoped = scope.where("service_id");
    const condition = `state<>'completed'${scoped ? ` AND ${scoped.sql}` : ""}`;
    const values = scoped?.values ?? [];
    const rows = await this.db
      .prepare(
        `SELECT delivery_jobs.*,services.name AS project_name FROM delivery_jobs LEFT JOIN services ON services.id=service_id WHERE ${condition} ORDER BY CASE state WHEN 'failed' THEN 0 ELSE 1 END,updated_at DESC,delivery_jobs.id LIMIT 100`,
      )
      .bind(...values)
      .all<JobRow>();
    const count = await this.db
      .prepare(`SELECT count(*) AS n FROM delivery_jobs WHERE ${condition}`)
      .bind(...values)
      .first<{ n: number }>();
    return ok({ items: rows.results.map(jobView), total: count?.n ?? 0 });
  }
  async retry(id: string, scope: Scope, actor: ActorRef): Promise<Result<OperatorDeliveryJob>> {
    const existing = await this.db
      .prepare("SELECT * FROM delivery_jobs WHERE id=?")
      .bind(id)
      .first<JobRow>();
    if (!existing || !scope.has(existing.service_id))
      return fail("NOT_FOUND", "処理が見つかりません。");
    if (existing.last_error === "MAIL_EXPIRED")
      return fail("CONFLICT", "保持期限を過ぎたメールは再処理できません。");
    const at = new Date(this.clock()).toISOString();
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO audit_logs SELECT ?, ?,?,'delivery.retried','system',id,json_object('kind',kind,'generation',generation+1),? FROM delivery_jobs WHERE id=? AND (state='failed' OR (state='queued' AND last_error IS NOT NULL)) AND generation=?`,
        )
        .bind(newId(), actor.type, actor.id ?? null, at, id, existing.generation),
      this.db
        .prepare(
          `UPDATE delivery_jobs SET state='queued',attempts=0,generation=generation+1,next_attempt_at=?,last_error=NULL,updated_at=? WHERE id=? AND (state='failed' OR (state='queued' AND last_error IS NOT NULL)) AND generation=?`,
        )
        .bind(at, at, id, existing.generation),
    ]);
    if (!result[1]?.meta.changes)
      return fail("CONFLICT", "自動再試行中、処理中、または完了済みです。");
    return ok(
      jobView(
        (await this.db.prepare("SELECT * FROM delivery_jobs WHERE id=?").bind(id).first<JobRow>())!,
      ),
    );
  }
  async purge(): Promise<void> {
    const cutoff = new Date(this.clock() - 90 * 86400_000).toISOString();
    await this.db
      .prepare(`DELETE FROM delivery_jobs WHERE state='completed' AND completed_at<?
        AND NOT EXISTS(SELECT 1 FROM delivery_jobs original
          WHERE delivery_jobs.id='alert-'||original.id||'-'||original.generation AND original.state<>'completed')`)
      .bind(cutoff)
      .run();
  }
}
