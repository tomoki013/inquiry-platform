import { createExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { AdminCore } from "../src/index";
import { admin, harness, seedApp, testEnv } from "./harness";

const keys = "test1:fo7nSQUnihDRS_AnJtn82f9hSXWpfl7S84QkzKdFqic";
let threadId: string;
beforeEach(async () => {
  const h = await harness();
  await seedApp(h, "orbit");
  await seedApp(h, "prism");
  const ticket = await h.support.createThread(
    {
      appSlug: "orbit",
      source: "web_form",
      subject: "Private subject",
      requesterName: "Example Person",
      requesterEmail: "person@example.com",
      bodyText: "Original private content",
    },
    admin,
  );
  if (!ticket.ok) throw new Error(ticket.error.message);
  threadId = ticket.value.id;
});

function core(slug: string) {
  const ctx = createExecutionContext();
  Object.defineProperty(ctx, "props", { value: { scope: { services: [slug] } } });
  return new AdminCore(ctx, { ...testEnv, PII_ENCRYPTION_KEYS: keys });
}
const packet = (text: string) => ({ reviewed: true, messages: [{ speaker: "customer", text }] });

it("hands off only reviewed excerpts once to their owner and current project scope", async () => {
  const operator = core("orbit");
  const actor = "operator-1";
  expect(
    await operator.createInquiryShare(threadId, { ...packet("Hello"), reviewed: false }, actor),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
  for (const privateText of ["EXAMPLE PERSON", "name@example.com", "０９０-１２３４-５６７８"]) {
    expect(await operator.createInquiryShare(threadId, packet(privateText), actor)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  }
  expect(await core("prism").createInquiryShare(threadId, packet("Hello"), actor)).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  const first = await operator.createInquiryShare(threadId, packet("An earlier excerpt"), actor);
  const last = await operator.createInquiryShare(threadId, packet("The approved excerpt"), actor);
  if (!first.ok || !last.ok) throw new Error(JSON.stringify({ first, last }));
  const { token } = last.value;
  for (const rejected of [
    await operator.takeInquiryShare(first.value.token, actor),
    await operator.takeInquiryShare(token, "other-operator"),
    await core("prism").takeInquiryShare(token, actor),
  ])
    expect(rejected).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  const stored = await testEnv.DB.prepare(
    "SELECT token_hash,context_ciphertext FROM inquiry_mcp_shares",
  ).first();
  expect(JSON.stringify(stored)).not.toContain(token);
  expect(JSON.stringify(stored)).not.toContain("The approved excerpt");
  const taken = await Promise.all([
    operator.takeInquiryShare(token, actor),
    operator.takeInquiryShare(token, actor),
  ]);
  expect(taken.filter((r) => r.ok)).toEqual([
    { ok: true, value: { messages: packet("The approved excerpt").messages } },
  ]);
  expect(await testEnv.DB.prepare("SELECT count(*) AS n FROM inquiry_mcp_shares").first("n")).toBe(
    0,
  );

  const revoked = await operator.createInquiryShare(threadId, packet("Revoked"), actor);
  if (!revoked.ok) throw new Error(revoked.error.message);
  await operator.revokeInquiryShare(actor);
  expect(await operator.takeInquiryShare(revoked.value.token, actor)).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});
