import { describe, expect, it } from "vitest";
import { appUrlSchema, createAppInputSchema } from "./apps";
import { assertSafeAuditMetadata } from "./audit";
import {
  renderTemplate,
  replySubject,
  sendSupportReplyInputSchema,
  unresolvedVariables,
} from "./reply";
import { canTransitionReport, createReportInputSchema } from "./reports";

describe("report status machine", () => {
  it("allows the documented moves", () => {
    expect(canTransitionReport("open", "reviewing")).toBe(true);
    expect(canTransitionReport("open", "closed")).toBe(true);
    expect(canTransitionReport("reviewing", "actioned")).toBe(true);
    expect(canTransitionReport("actioned", "closed")).toBe(true);
    expect(canTransitionReport("closed", "reviewing")).toBe(true);
  });

  it("refuses the ones that would skip a step", () => {
    // Straight from open to actioned would record an outcome for a report
    // nobody looked at.
    expect(canTransitionReport("open", "actioned")).toBe(false);
    expect(canTransitionReport("closed", "actioned")).toBe(false);
    expect(canTransitionReport("actioned", "reviewing")).toBe(false);
  });
});

describe("replySubject", () => {
  it("adds one prefix", () => {
    expect(replySubject("アプリで共有できません")).toBe("Re: アプリで共有できません");
  });

  it("does not stack prefixes however many round trips there have been", () => {
    expect(replySubject("Re: Re: アプリで共有できません")).toBe("Re: アプリで共有できません");
    expect(replySubject("RE: アプリで共有できません")).toBe("Re: アプリで共有できません");
    expect(replySubject("Re[2]: hello")).toBe("Re: hello");
  });

  it("survives an empty subject", () => {
    expect(replySubject("   ")).toBe("Re:");
  });
});

describe("template variables", () => {
  it("fills what it knows", () => {
    const rendered = renderTemplate("{{appName}} のサポートです", { appName: "Remeet" });
    expect(rendered).toBe("Remeet のサポートです");
  });

  it("leaves an unknown name standing so the send can refuse it", () => {
    const rendered = renderTemplate("{{userName}}様", { userName: undefined });
    expect(rendered).toBe("{{userName}}様");
    expect(unresolvedVariables(rendered)).toEqual(["userName"]);
  });

  it("reports each placeholder once, in order", () => {
    expect(unresolvedVariables("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("appUrlSchema", () => {
  it("takes https", () => {
    expect(appUrlSchema().safeParse("https://tmkch.io").success).toBe(true);
  });

  it("refuses plain http, credentials, and other schemes", () => {
    expect(appUrlSchema().safeParse("http://tmkch.io").success).toBe(false);
    expect(appUrlSchema().safeParse("https://user:pass@tmkch.io").success).toBe(false);
    expect(appUrlSchema().safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("allows localhost only when the caller asked for it", () => {
    expect(appUrlSchema({ allowLocalhost: true }).safeParse("http://localhost:4321").success).toBe(
      true,
    );
    expect(appUrlSchema().safeParse("http://localhost:4321").success).toBe(false);
  });
});

describe("assertSafeAuditMetadata", () => {
  it("takes ids, codes and counts", () => {
    expect(() =>
      assertSafeAuditMetadata({ appSlug: "remeet", count: 3, threaded: true }),
    ).not.toThrow();
  });

  it("refuses anything that looks like content", () => {
    expect(() => assertSafeAuditMetadata({ bodyText: "hello" })).toThrow();
    expect(() => assertSafeAuditMetadata({ requesterEmail: "a@b.c" })).toThrow();
    expect(() => assertSafeAuditMetadata({ jwt: "x" })).toThrow();
    expect(() => assertSafeAuditMetadata({ note: "x" })).toThrow();
  });

  it("refuses prose hiding in an innocent key", () => {
    expect(() => assertSafeAuditMetadata({ summary: "x".repeat(400) })).toThrow();
    expect(() => assertSafeAuditMetadata({ nested: { a: 1 } as never })).toThrow();
  });
});

describe("input schemas", () => {
  it("bounds a report snapshot", () => {
    const parsed = createReportInputSchema.safeParse({
      appSlug: "remeet",
      externalReportId: "abc",
      contentType: "wish",
      reasonCode: "spam",
      snapshotText: "x".repeat(9000),
    });
    expect(parsed.success).toBe(false);
  });

  it("requires an idempotency key long enough to be unguessable", () => {
    expect(
      sendSupportReplyInputSchema.safeParse({
        threadId: "t",
        bodyText: "hello",
        idempotencyKey: "short",
      }).success,
    ).toBe(false);
  });

  it("refuses a slug that is not a slug", () => {
    const parsed = createAppInputSchema.safeParse({
      slug: "Not A Slug",
      name: "x",
      platform: "ios",
      status: "live",
    });
    expect(parsed.success).toBe(false);
  });
});
