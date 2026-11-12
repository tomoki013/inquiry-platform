import { fail, ok, type Result } from "@inquiry-platform/core";
import { sha256Hex } from "./domain/identity";
import type { AdminCoreEnv } from "./env";
import { privateCipher } from "./privacy/crypto";
import type { Domain, DomainFeatures } from "./project-features";

const encode = (text: string) => new TextEncoder().encode(text);

interface Verification {
  existing(): Promise<Result<string | null>>;
  verify(): Promise<Result<void>>;
  tokenUsed(): Promise<boolean>;
  statement(db: D1Database, sourceId: string): D1PreparedStatement;
}

export async function prepareVerification(
  db: D1Database,
  env: AdminCoreEnv,
  config: NonNullable<DomainFeatures["turnstile"]>,
  scope: { projectId: string; domain: Domain; caller: string; key: string },
  { turnstileToken, ...payload }: { turnstileToken?: string },
): Promise<Verification> {
  const { projectId, domain, caller, key } = scope;
  const requestKey = await sha256Hex(encode(key));
  const payloadHash = await sha256Hex(encode(JSON.stringify([caller, payload])));
  const cipher = privateCipher(env);
  const storedHash = cipher ? await cipher.seal(payloadHash, projectId) : payloadHash;
  let tokenHash: string | null = null;
  const tokenUsed = async () =>
    tokenHash !== null &&
    Boolean(
      await db
        .prepare("SELECT 1 FROM intake_verifications WHERE token_hash=?")
        .bind(tokenHash)
        .first(),
    );
  return {
    tokenUsed,
    async existing() {
      const row = await db
        .prepare(
          "SELECT payload_hash,source_id FROM intake_verifications WHERE project_id=? AND domain=? AND request_key=?",
        )
        .bind(projectId, domain, requestKey)
        .first<{ payload_hash: string; source_id: string }>();
      if (
        row &&
        (cipher ? await cipher.open(row.payload_hash, projectId) : row.payload_hash) !== payloadHash
      )
        return fail("CONFLICT", "この受付キーは別の内容で使用されています。");
      return ok(row?.source_id ?? null);
    },
    async verify() {
      if (config.trustedCallers.includes(caller)) return ok(undefined);
      if (!turnstileToken) return fail("VALIDATION_ERROR", "Turnstile の確認が必要です。");
      const secret = Object.hasOwn(env, config.secretBinding)
        ? Reflect.get(env, config.secretBinding)
        : undefined;
      const unavailable = () => fail("INTERNAL_ERROR", "受付の確認が一時的に利用できません。");
      if (typeof secret !== "string" || !secret.trim()) return unavailable();
      tokenHash = await sha256Hex(encode(turnstileToken));
      if (await tokenUsed())
        return fail("VALIDATION_ERROR", "Turnstile をもう一度実行してください。");
      try {
        const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret, response: turnstileToken }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return unavailable();
        const value = await response.json<{
          success?: boolean;
          hostname?: string;
          action?: string;
          "error-codes"?: string[];
        }>();
        if (value["error-codes"]?.includes("internal-error")) return unavailable();
        if (
          value.success !== true ||
          !config.hostnames.includes(value.hostname ?? "") ||
          value.action !== config.action
        )
          return fail("VALIDATION_ERROR", "Turnstile をもう一度実行してください。");
        return ok(undefined);
      } catch {
        return unavailable();
      }
    },
    statement(database, sourceId) {
      return database
        .prepare("INSERT INTO intake_verifications VALUES(?,?,?,?,?,?,?)")
        .bind(
          projectId,
          domain,
          requestKey,
          storedHash,
          sourceId,
          tokenHash,
          Date.now() + 10 * 60_000,
        );
    },
  };
}
