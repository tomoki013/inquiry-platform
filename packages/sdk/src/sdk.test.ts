import { describe, expect, it, vi } from "vitest";
import { createInquiryClient } from "./client";
import type { IntakeBinding } from "./types";
import {
  internalTicketStatuses,
  internalTicketTypes,
  toPublicStatus,
  toPublicType,
} from "./vocabulary";

describe("vocabulary", () => {
  it("maps every internal status onto the four public ones", () => {
    expect(internalTicketStatuses.map(toPublicStatus)).toEqual([
      "OPEN",
      "OPEN",
      "OPEN",
      "IN_PROGRESS",
      "IN_PROGRESS",
      "IN_PROGRESS",
      "RESOLVED",
      "CLOSED",
    ]);
  });

  it("maps inquiries to contact and reports to report", () => {
    expect(toPublicType("INQUIRY")).toBe("contact");
    expect(toPublicType("REPORT")).toBe("report");
    expect(toPublicType("BUG")).toBe("bug");
    for (const type of internalTicketTypes) expect(toPublicType(type)).toBeTruthy();
  });
});

describe("createInquiryClient", () => {
  it("answers UNAVAILABLE instead of throwing when there is no binding", async () => {
    const client = createInquiryClient(undefined);
    const results = await Promise.all([
      client.createContact({ idempotencyKey: "k", subject: "s", message: "m", channel: "app" }),
      client.createReport({
        projectSlug: "p",
        externalReportId: "r",
        targetType: "t",
        reason: "x",
      }),
      client.attachReportEvidence("r", { bytes: new Uint8Array(1), contentType: "image/png" }),
    ]);
    for (const result of results) {
      expect(result).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    }
  });

  it("sends evidence as a PUT with its headers and maps refusals to codes", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ attachmentId: "a", sha256: "s", byteSize: 3 }, { status: 201 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 413 }));
    const client = createInquiryClient({ fetch } as unknown as IntakeBinding);
    const evidence = {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      createdAt: "2026-09-24T00:00:00Z",
    };

    expect(await client.attachReportEvidence("r/1", evidence)).toEqual({
      ok: true,
      value: { attachmentId: "a", sha256: "s", byteSize: 3 },
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://intake.internal/internal/reports/r%2F1/attachments");
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({
      "Content-Type": "image/png",
      "Content-Length": "3",
      "X-Evidence-Created-At": "2026-09-24T00:00:00Z",
    });

    expect(await client.attachReportEvidence("r", evidence)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await client.attachReportEvidence("r", evidence)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });
});
