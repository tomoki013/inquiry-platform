import { describe, expect, it } from "vitest";
import { admin, appActor, expectOk, FakeMailProvider, harness, seedApp } from "./harness";

/*
 * A project can word its own report receipt: its mail route names one of its
 * templates. The receipt ID still reaches the mail ({{reportId}}), and any
 * doubt — a missing, inactive or another project's template, or a placeholder
 * left over — falls back to the generic receipt rather than sending nothing.
 */

const reportId = "22222222-2222-4222-8222-222222222222";
const report = {
  appSlug: "orbit",
  externalReportId: reportId,
  contentType: "store",
  reasonCode: "spam",
  contentExternalId: "content-1",
  reporterRefHash: "reporter-raw-id",
  snapshotText: "対象",
  reporterEmail: "reporter@example.com",
};

async function setup(
  templateBody: string,
  options: { route?: boolean; active?: boolean; otherApp?: boolean } = {},
) {
  const own = new FakeMailProvider();
  const h = await harness({
    delivery: (id) =>
      id
        ? {
            mail: own,
            defaultSignature: "Orbit Support",
            ...(options.route === false ? {} : { reportReceiptTemplate: "orbit_report_receipt" }),
          }
        : { mail: new FakeMailProvider(false) },
  });
  const appId = await seedApp(h, "orbit");
  const otherId = options.otherApp ? await seedApp(h, "prism") : undefined;
  expectOk(
    (await h.reply.createTemplate(
      {
        key: "orbit_report_receipt",
        name: "受付",
        category: "acknowledgement",
        appId: otherId ?? appId,
        body: templateBody,
        includeSignature: true,
        isActive: options.active ?? true,
        sortOrder: 0,
      },
      admin,
    )) as never,
  );
  expectOk((await h.reports.create(report, appActor)) as never);
  await h.settled();
  return own;
}

describe("a project's own report receipt", () => {
  it("is written with the project's template and carries the receipt ID", async () => {
    const own = await setup(
      "お客様\n\n{{appName}}への通報を受け付けました。\n\n受付ID: {{reportId}}\n\n以上、よろしくお願いいたします。",
    );
    expect(own.sent).toHaveLength(1);
    const text = own.sent[0]?.text ?? "";
    expect(text).toContain(`受付ID: ${reportId}\n\n以上、よろしくお願いいたします。`);
    expect(text).not.toContain("表示に戻す");
    expect(text).not.toContain("{{");
    // The receipt line is in the body, so it is not appended a second time.
    expect(text.split(`受付ID: ${reportId}`)).toHaveLength(2);
  });

  it("falls back to the generic receipt when the template cannot be used", async () => {
    for (const options of [{ route: false }, { active: false }, { otherApp: true }]) {
      const own = await setup("受付ID: {{reportId}}", options);
      expect(own.sent[0]?.text).toContain(
        "通報を受け付けました。お知らせいただきありがとうございます。",
      );
    }
    const leftover = await setup("{{answer}} 受付ID: {{reportId}}");
    expect(leftover.sent[0]?.text).toContain(
      "通報を受け付けました。お知らせいただきありがとうございます。",
    );
  });
});
