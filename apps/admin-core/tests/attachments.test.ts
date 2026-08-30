import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { CreateReportResult, ReportDetail } from "@tomokichi/admin-contracts";
import { INTERNAL_ORIGIN, INTERNAL_PATHS, MAX_ATTACHMENT_BYTES } from "@tomokichi/admin-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import AdminCore from "../src/index";
import { appActor, expectOk, type Harness, harness, testEnv } from "./harness";

let h: Harness;
let core: AdminCore;
let reportId: string;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeEach(async () => {
  h = await harness();
  await h.apps.create(
    { slug: "remeet", name: "Remeet", platform: "ios", status: "testflight" },
    {
      type: "admin",
      id: "t",
    },
  );
  reportId = expectOk<CreateReportResult>(
    (await h.reports.create(
      { appSlug: "remeet", externalReportId: "ext-1", contentType: "wish", reasonCode: "sexual" },
      appActor,
    )) as never,
  ).reportId;
  core = new AdminCore(createExecutionContext(), testEnv as never);
});

async function put(path: string, body: Uint8Array, contentType = "image/png"): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await core.fetch(
    new Request(`${INTERNAL_ORIGIN}${path}`, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.byteLength),
        "X-Attachment-Filename": "evidence.png",
      },
      body,
    }),
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("report evidence", () => {
  it("stores the bytes in R2 and only metadata in D1", async () => {
    const response = await put(INTERNAL_PATHS.reportAttachment(reportId), PNG);
    expect(response.status).toBe(201);
    const { attachmentId, sha256 } = (await response.json()) as {
      attachmentId: string;
      sha256: string;
    };

    const detail = expectOk<ReportDetail>((await h.reports.detail(reportId)) as never);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]?.byteSize).toBe(PNG.byteLength);
    expect(detail.attachments[0]?.sha256).toBe(sha256);

    // The photo itself is not in the database — only a reference to it.
    const row = await testEnv.DB.prepare("SELECT * FROM report_attachments WHERE id = ?")
      .bind(attachmentId)
      .first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain("iVBOR");
    expect(row?.r2_key).toBe(`reports/${reportId}/${attachmentId}`);

    // And uploading it is part of the report's history.
    expect(detail.events.map((event) => event.eventType)).toContain("attachment_added");
  });

  it("serves it back with no-store and a nosniff header, never a public URL", async () => {
    const created = await put(INTERNAL_PATHS.reportAttachment(reportId), PNG);
    const { attachmentId } = (await created.json()) as { attachmentId: string };

    const response = await core.fetch(
      new Request(`${INTERNAL_ORIGIN}${INTERNAL_PATHS.reportAttachment(reportId, attachmentId)}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toContain("inline");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  /**
   * A file emailed by a stranger must not be able to run script in the admin
   * origin by being previewed. Anything not on the inline allowlist is served
   * as an opaque download.
   */
  it("refuses to serve a dangerous type inline", async () => {
    const created = await put(
      INTERNAL_PATHS.reportAttachment(reportId),
      new TextEncoder().encode("<svg onload=alert(1)>"),
      "image/svg+xml",
    );
    const { attachmentId } = (await created.json()) as { attachmentId: string };

    const response = await core.fetch(
      new Request(`${INTERNAL_ORIGIN}${INTERNAL_PATHS.reportAttachment(reportId, attachmentId)}`),
    );
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
  });

  it("never puts a caller-supplied filename in the object key", async () => {
    const ctx = createExecutionContext();
    const response = await core.fetch(
      new Request(`${INTERNAL_ORIGIN}${INTERNAL_PATHS.reportAttachment(reportId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(PNG.byteLength),
          "X-Attachment-Filename": "../../etc/passwd",
        },
        body: PNG,
      }),
    );
    await waitOnExecutionContext(ctx);
    const { attachmentId } = (await response.json()) as { attachmentId: string };
    const row = await testEnv.DB.prepare(
      "SELECT r2_key, original_filename FROM report_attachments WHERE id = ?",
    )
      .bind(attachmentId)
      .first<{ r2_key: string; original_filename: string }>();

    expect(row?.r2_key).toBe(`reports/${reportId}/${attachmentId}`);
    // Kept as a label, never used as a path.
    expect(row?.original_filename).toBe("../../etc/passwd");
  });

  it("refuses an upload past the size ceiling", async () => {
    const ctx = createExecutionContext();
    const response = await core.fetch(
      new Request(`${INTERNAL_ORIGIN}${INTERNAL_PATHS.reportAttachment(reportId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(MAX_ATTACHMENT_BYTES + 1),
        },
        body: PNG,
      }),
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(413);
  });

  it("refuses an attachment for a report that does not exist", async () => {
    const response = await put(INTERNAL_PATHS.reportAttachment("no-such-report"), PNG);
    expect(response.status).toBe(404);
  });

  it("does not serve one report's evidence under another report's id", async () => {
    const created = await put(INTERNAL_PATHS.reportAttachment(reportId), PNG);
    const { attachmentId } = (await created.json()) as { attachmentId: string };

    const other = expectOk<CreateReportResult>(
      (await h.reports.create(
        { appSlug: "remeet", externalReportId: "ext-2", contentType: "wish", reasonCode: "spam" },
        appActor,
      )) as never,
    ).reportId;

    const response = await core.fetch(
      new Request(`${INTERNAL_ORIGIN}${INTERNAL_PATHS.reportAttachment(other, attachmentId)}`),
    );
    expect(response.status).toBe(404);
  });
});

describe("unknown internal paths", () => {
  it("are 404, not a stack trace", async () => {
    const response = await core.fetch(new Request(`${INTERNAL_ORIGIN}/internal/nope`));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"NOT_FOUND"}');
  });
});
