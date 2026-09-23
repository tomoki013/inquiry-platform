import { ATTACHMENT_FILENAME_HEADER } from "@inquiry-platform/core";
import { FileStore } from "./db/files";
import { ReportRepository } from "./db/reports";
import { sha256Hex } from "./domain/identity";
import type { AdminCoreEnv } from "./env";
import { json, readBounded } from "./http";

/**
 * Stores one piece of report evidence in the private bucket.
 *
 * Shared by both doors into this Worker: the platform's own `AdminCore`
 * entrypoint and a project's `Intake`, which checks first that the report
 * belongs to one of its projects. Idempotent on the bytes: the same image
 * sent twice is one attachment.
 */
export async function putReportEvidence(
  env: AdminCoreEnv,
  reportId: string,
  request: Request,
): Promise<Response> {
  const files = new FileStore(env.PRIVATE_FILES);
  const reports = new ReportRepository(env.DB);
  if (!(await reports.findRow(reportId))) return json({ error: "NOT_FOUND" }, 404);
  const body = await readBounded(request);
  if (!body) return json({ error: "TOO_LARGE" }, 413);

  const suppliedDate = request.headers.get("X-Evidence-Created-At");
  const created = suppliedDate ? Date.parse(suppliedDate) : Date.now();
  if (!Number.isFinite(created) || created > Date.now())
    return json({ error: "INVALID_DATE" }, 400);
  if (Date.now() >= created + 30 * 86400_000) return json({ error: "EXPIRED" }, 410);
  const attachmentId = await sha256Hex(
    new TextEncoder().encode(`${reportId}:${await sha256Hex(body)}`),
  );
  const existing = await reports.findAttachment(reportId, attachmentId);
  if (existing)
    return json({ attachmentId, sha256: existing.sha256, byteSize: existing.byte_size }, 200);
  const key = FileStore.reportKey(reportId, attachmentId);
  const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
  const filename = request.headers.get(ATTACHMENT_FILENAME_HEADER) ?? undefined;
  const stored = await files.put(key, body, contentType);

  await env.DB.batch([
    reports.attachmentStatement({
      id: attachmentId,
      reportId,
      r2Key: key,
      contentType,
      originalFilename: filename,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      createdAt: new Date(created).toISOString(),
    }),
    reports.eventStatement({ reportId, eventType: "attachment_added" }),
  ]);
  return json({ attachmentId, sha256: stored.sha256, byteSize: stored.byteSize }, 201);
}
