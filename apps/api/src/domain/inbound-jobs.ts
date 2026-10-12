import { MAX_ATTACHMENT_BYTES } from "@inquiry-platform/core";
import { parseInboundEmail } from "@inquiry-platform/mail-parser";
import {
  INBOUND_PREFIX,
  persistInboundMail,
  readInboundBytes,
} from "@inquiry-platform/mail-parser/journal";
import { FileStore } from "../db/files";
import type { SupportRepository } from "../db/support";
import type { AdminCoreEnv } from "../env";
import { json } from "../http";
import { DeliveryError, type DeliveryJobs, type JobRow } from "./delivery-jobs";
import { sha256Hex } from "./identity";
import type { SupportService } from "./support-service";

const PREFIX = INBOUND_PREFIX;
const RETENTION = 30 * 86400_000;
export class InboundJobs {
  constructor(
    private readonly env: AdminCoreEnv,
    private readonly jobs: DeliveryJobs,
    private readonly support: SupportService,
    private readonly repo: SupportRepository,
  ) {}
  private async service(projectSlug: string): Promise<string> {
    if (projectSlug) {
      const app = await this.env.DB.prepare("SELECT id FROM apps WHERE slug=?")
        .bind(projectSlug)
        .first<{ id: string }>();
      if (!app) throw new DeliveryError("PROJECT_UNAVAILABLE");
      return app.id;
    }
    return (
      (
        await this.env.DB.prepare(
          "SELECT value FROM platform_settings WHERE key='default_service_id'",
        ).first<{ value: string }>()
      )?.value ?? "unassigned"
    );
  }
  async store(request: Request): Promise<Response> {
    const projectSlug = request.headers.get("X-Mail-Project") ?? "";
    const to = request.headers.get("X-Mail-To") ?? "";
    if (projectSlug && !/^[a-z0-9-]{1,64}$/.test(projectSlug))
      return json({ error: "VALIDATION_ERROR" }, 400);
    if (to.length > 254 || !to) return json({ error: "VALIDATION_ERROR" }, 400);
    if (!request.body) return json({ error: "VALIDATION_ERROR" }, 400);
    let bytes: Uint8Array;
    try {
      bytes = await readInboundBytes(request.body);
    } catch (error) {
      if (error instanceof RangeError) return json({ error: "TOO_LARGE" }, 413);
      throw error;
    }
    const { id, key } = await persistInboundMail(this.env.PRIVATE_FILES, bytes, to, projectSlug);
    const serviceId = await this.service(projectSlug);
    const existing = await this.env.DB.prepare("SELECT state FROM delivery_jobs WHERE id=?")
      .bind(id)
      .first<{ state: string }>();
    if (existing?.state === "completed") {
      await this.env.PRIVATE_FILES.delete(key);
      return json({ jobId: id }, 202);
    }
    await this.jobs.statement(id, serviceId, "inbound_email", { key, to, projectSlug }).run();
    return json({ jobId: id }, 202);
  }
  async process(row: JobRow): Promise<() => Promise<void>> {
    const payload = JSON.parse(row.payload) as { key: string; to: string; projectSlug: string };
    const object = await this.env.PRIVATE_FILES.get(payload.key);
    if (!object) throw new DeliveryError("RAW_MAIL_MISSING");
    if (Date.now() - Date.parse(object.customMetadata?.createdAt ?? "") > RETENTION)
      throw new DeliveryError("MAIL_EXPIRED");
    let parsed: Awaited<ReturnType<typeof parseInboundEmail>>;
    try {
      parsed = await parseInboundEmail(await object.arrayBuffer());
    } catch {
      throw new DeliveryError("MAIL_PARSE_FAILED");
    }
    if (!parsed.from) throw new DeliveryError("MAIL_SENDER_MISSING");
    const result = await this.support.ingestInboundEmail(
      {
        from: parsed.from,
        to: payload.to,
        subject: parsed.subject,
        bodyText: parsed.bodyText,
        messageId: parsed.messageId ?? row.id,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        requesterName: parsed.fromName,
        ...(payload.projectSlug ? { appSlug: payload.projectSlug } : {}),
      },
      { type: "email", id: "mail-ingress" },
    );
    if (!result.ok) throw new DeliveryError("MAIL_INGEST_FAILED");
    const files = new FileStore(this.env.PRIVATE_FILES);
    for (const [index, attachment] of parsed.attachments.entries()) {
      if (!attachment.bytes.byteLength || attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES)
        continue;
      const id = await sha256Hex(new TextEncoder().encode(`${row.id}:${index}`));
      if (
        await this.env.DB.prepare("SELECT 1 FROM support_attachments WHERE id=?").bind(id).first()
      )
        continue;
      const key = FileStore.supportKey(result.value.threadId, result.value.messageId, id);
      const stored = await files.put(key, attachment.bytes, attachment.contentType);
      await this.repo
        .attachmentStatement({
          id,
          messageId: result.value.messageId,
          r2Key: key,
          contentType: attachment.contentType,
          originalFilename: attachment.filename,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
        })
        .run();
    }
    return () => this.env.PRIVATE_FILES.delete(payload.key);
  }
  async reconcile(): Promise<void> {
    const cursor = (
      await this.env.DB.prepare(
        "SELECT value FROM platform_settings WHERE key='inbound_reconcile_cursor'",
      ).first<{ value: string }>()
    )?.value;
    const page = await this.env.PRIVATE_FILES.list({
      prefix: PREFIX,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of page.objects) {
      const object = await this.env.PRIVATE_FILES.head(item.key);
      const meta = object?.customMetadata;
      if (!meta?.to || !meta.createdAt) continue;
      const id = item.key.slice(PREFIX.length);
      const row = await this.env.DB.prepare("SELECT state FROM delivery_jobs WHERE id=?")
        .bind(id)
        .first<{ state: string }>();
      if (row?.state === "completed") {
        await this.env.PRIVATE_FILES.delete(item.key);
        continue;
      }
      if (!row)
        await this.jobs
          .statement(id, await this.service(meta.projectSlug ?? ""), "inbound_email", {
            key: item.key,
            to: meta.to,
            projectSlug: meta.projectSlug ?? "",
          })
          .run();
      if (Date.now() - Date.parse(meta.createdAt) > RETENTION) {
        await this.env.DB.prepare(
          "UPDATE delivery_jobs SET state='failed',last_error='MAIL_EXPIRED',payload='{}',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND state<>'completed'",
        )
          .bind(new Date().toISOString(), id)
          .run();
        await this.env.PRIVATE_FILES.delete(item.key);
      }
    }
    await this.env.DB.prepare(
      "INSERT INTO platform_settings(key,value) VALUES('inbound_reconcile_cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
      .bind(page.truncated ? page.cursor : "")
      .run();
  }
}
