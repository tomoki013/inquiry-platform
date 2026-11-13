import { fail, ok } from "@inquiry-platform/core";
import { z } from "zod";
import { sha256Hex } from "./domain/identity";
import type { Scope } from "./domain/scope";
import type { AdminCoreEnv } from "./env";
import { privateCipher } from "./privacy/crypto";

const shareSchema = z
  .object({
    reviewed: z.literal(true),
    messages: z
      .array(
        z
          .object({
            speaker: z.enum(["customer", "support"]),
            text: z.string().trim().min(1).max(6000),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .refine(({ messages }) => messages.reduce((sum, m) => sum + m.text.length, 0) <= 12000);

const digest = (value: string) => sha256Hex(new TextEncoder().encode(value));
const tokenPattern = /^[a-f0-9]{64}$/;
const email = /[\p{L}\p{N}_.+%-]+\s*@\s*[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu;
const phone = /(?<!\d)\+?\d(?:[\s().-]*\d){8,}(?!\d)/u;

export async function createInquiryShare(
  env: AdminCoreEnv,
  actor: string,
  raw: unknown,
  requester: { service_id: string; requester_name: string | null; requester_email: string },
) {
  const parsed = shareSchema.safeParse(raw);
  if (!parsed.success) return fail("VALIDATION_ERROR", "共有する文章を確認してください。");
  const normalize = (s: string) => s.normalize("NFKC").toLowerCase();
  const known = [requester.requester_name, requester.requester_email].flatMap((value) =>
    value?.trim() ? [normalize(value.trim())] : [],
  );
  const hasIdentity = parsed.data.messages.some(({ text }) => {
    const normalized = normalize(text);
    return (
      email.test(normalized) ||
      phone.test(normalized) ||
      known.some((value) => normalized.includes(value))
    );
  });
  if (hasIdentity)
    return fail(
      "VALIDATION_ERROR",
      "氏名、メールアドレス、電話番号に見える記述を削除してください。",
    );
  const cipher = privateCipher(env);
  if (!cipher) return fail("FORBIDDEN", "共有用の暗号化が設定されていません。");
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const expiresAt = Date.now() + 10 * 60_000;
  const sealed = await cipher.seal(JSON.stringify(parsed.data.messages), "inquiry-mcp-share");
  await env.DB.prepare(
    `INSERT INTO inquiry_mcp_shares VALUES(?,?,?,?,?)
     ON CONFLICT(actor_id) DO UPDATE SET service_id=excluded.service_id,token_hash=excluded.token_hash,
       context_ciphertext=excluded.context_ciphertext,expires_at=excluded.expires_at`,
  )
    .bind(actor, requester.service_id, await digest(token), sealed, expiresAt)
    .run();
  return ok({ token, expiresAt: new Date(expiresAt).toISOString() });
}

export async function takeInquiryShare(
  env: AdminCoreEnv,
  actor: string,
  token: string,
  scope: Scope,
) {
  if (!tokenPattern.test(token)) return fail("NOT_FOUND", "共有が見つかりません。");
  const cipher = privateCipher(env);
  if (!cipher) return fail("FORBIDDEN", "共有用の暗号化が設定されていません。");
  const grant = scope.where("service_id");
  const row = await env.DB.prepare(
    `DELETE FROM inquiry_mcp_shares WHERE actor_id=? AND token_hash=? AND expires_at>?
      ${grant ? `AND ${grant.sql}` : ""} RETURNING context_ciphertext`,
  )
    .bind(actor, await digest(token), Date.now(), ...(grant?.values ?? []))
    .first<string>("context_ciphertext");
  if (!row) return fail("NOT_FOUND", "共有が見つかりません。");
  const messages = shareSchema.parse({
    reviewed: true,
    messages: JSON.parse(await cipher.open(row, "inquiry-mcp-share")),
  }).messages;
  return ok({ messages });
}

export async function revokeInquiryShare(env: AdminCoreEnv, actor: string) {
  await env.DB.prepare("DELETE FROM inquiry_mcp_shares WHERE actor_id=?").bind(actor).run();
  return ok(null);
}
