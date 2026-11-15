import { describe, expect, it } from "vitest";
import { appUrlSchema, createAppInputSchema } from "./apps";
import { assertSafeAuditMetadata } from "./audit";
import {
  DEFAULT_REPLY_SUBJECT,
  renderTemplate,
  replySubject,
  replySubjectFor,
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
    // Nor is standing still a move.
    expect(canTransitionReport("open", "open")).toBe(false);
  });
});

describe("replySubject", () => {
  it("prefixes once, however many round trips there have been", () => {
    expect(replySubject("アプリで共有できません")).toBe("Re: アプリで共有できません");
    expect(replySubject("Re: Re: アプリで共有できません")).toBe("Re: アプリで共有できません");
    expect(replySubject("RE: アプリで共有できません")).toBe("Re: アプリで共有できません");
    expect(replySubject("Re[2]: hello")).toBe("Re: hello");
  });

  it("folds the prefixes other clients and languages produce into one Re:", () => {
    for (const subject of [
      "Re：アプリで共有できません",
      "Ｒｅ: アプリで共有できません",
      "返信: アプリで共有できません",
      "返信：Re: アプリで共有できません",
      "AW: Re: アプリで共有できません",
      "Re(3): アプリで共有できません",
      "re : RE:アプリで共有できません",
      "Re: Re[2]: 返信: アプリで共有できません",
    ])
      expect(replySubject(subject)).toBe("Re: アプリで共有できません");
  });

  it("leaves everything after the leading prefixes alone", () => {
    expect(replySubject("Fwd: 共有について")).toBe("Re: Fwd: 共有について");
    expect(replySubject("Re: 返信が来ない件 [TK-000123]")).toBe("Re: 返信が来ない件 [TK-000123]");
    expect(replySubject("Release notes")).toBe("Re: Release notes");
    expect(replySubject("[TK-000123] Re: 共有")).toBe("Re: [TK-000123] Re: 共有");
  });

  it("survives an empty subject", () => {
    expect(replySubject("   ")).toBe("Re:");
  });
});

describe("replySubjectFor", () => {
  const form = { subject: "[bug] 8f21c", source: "web_form" as const };
  const mail = { subject: "Re: 共有できません", source: "email" as const };

  it("answers a mail inquiry with Re: what they wrote, whatever the template says", () => {
    expect(replySubjectFor(mail, "テンプレートの件名")).toBe("Re: 共有できません");
  });

  it("chooses a form's first subject: the template's, else the default", () => {
    expect(replySubjectFor(form, " テンプレートの件名 ")).toBe("テンプレートの件名");
    expect(replySubjectFor(form)).toBe(DEFAULT_REPLY_SUBJECT);
  });

  it("echoes the conversation's latest subject once there is one", () => {
    const receipt = "お問い合わせを受け付けました: 共有 [TK-000123]";
    expect(replySubjectFor({ ...form, mailSubject: receipt }, "テンプレートの件名")).toBe(
      `Re: ${receipt}`,
    );
    expect(replySubjectFor({ ...mail, mailSubject: "新しい件名 [TK-000123]" })).toBe(
      "Re: 新しい件名 [TK-000123]",
    );
    expect(replySubjectFor({ ...mail, mailSubject: "Re: Re: 新しい件名" })).toBe("Re: 新しい件名");
  });
});

describe("template variables", () => {
  it("fills what it knows", () => {
    const rendered = renderTemplate("{{appName}} のサポートです", { appName: "Orbit" });
    expect(rendered).toBe("Orbit のサポートです");
  });

  it("leaves an unknown name standing so the send can refuse it", () => {
    const rendered = renderTemplate("{{userName}}様", { userName: undefined });
    expect(rendered).toBe("{{userName}}様");
    expect(unresolvedVariables(rendered)).toEqual(["userName"]);
  });

  it("uses a template's own words for an unknown value, and the value when there is one", () => {
    const body = "{{userName|お客様}} 様 / {{ userName | どなたか }}";
    const anonymous = renderTemplate(body, { userName: undefined });
    expect(anonymous).toBe("お客様 様 / どなたか");
    expect(unresolvedVariables(anonymous)).toEqual([]);
    expect(renderTemplate(body, { userName: "山田" })).toBe("山田 様 / 山田");
  });

  it("reports each placeholder once, in order", () => {
    expect(unresolvedVariables("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });
});

describe("appUrlSchema", () => {
  it("takes https", () => {
    expect(appUrlSchema().safeParse("https://example.com").success).toBe(true);
  });

  it("refuses plain http, credentials, and other schemes", () => {
    expect(appUrlSchema().safeParse("http://example.com").success).toBe(false);
    expect(appUrlSchema().safeParse("https://user:pass@example.com").success).toBe(false);
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
      assertSafeAuditMetadata({ appSlug: "orbit", count: 3, threaded: true }),
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
      appSlug: "orbit",
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
