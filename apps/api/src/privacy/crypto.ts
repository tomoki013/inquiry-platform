/** Worker-only encryption. Key material is never stored with the database. */
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const prefix = "private:v1:";
const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
function base64(bytes: Uint8Array) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192)
    result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export class PrivateCipher {
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  private readonly active: string;
  private readonly indexKey?: Promise<CryptoKey>;
  constructor(source: string, hashKey?: string) {
    if (hashKey) {
      const bytes = decode(hashKey);
      if (bytes.length !== 32) throw new Error("InvalidPrivateHashKey");
      this.indexKey = crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    }
    const entries = source.split(",");
    this.active = entries[0]?.split(":")[0] ?? "";
    for (const entry of entries) {
      const [id, value, extra] = entry.split(":");
      if (!id || !/^[a-z0-9]{1,16}$/.test(id) || !value || extra || this.keys.has(id))
        throw new Error("InvalidPrivateKeyring");
      const raw = decode(value);
      if (raw.length !== 32) throw new Error("InvalidPrivateKeyring");
      this.keys.set(id, crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]));
    }
  }
  private async key(id: string, scope: string) {
    const master = this.keys.get(id);
    if (!master) throw new Error("PrivateKeyUnavailable");
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("private-storage:v1"),
        info: encoder.encode(scope),
      },
      await master,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
  async index(value: string): Promise<string> {
    if (!this.indexKey) throw new Error("PrivateHashKeyRequired");
    return (
      "h1:" +
      base64(
        new Uint8Array(
          await crypto.subtle.sign(
            "HMAC",
            await this.indexKey,
            encoder.encode("push-endpoint\0" + value),
          ),
        ),
      )
    );
  }
  async seal(value: string, scope: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = `${prefix}${this.active}:${encode(encoder.encode(scope))}`;
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(header) },
      await this.key(this.active, scope),
      encoder.encode(value),
    );
    return `${header}:${encode(iv)}:${base64(new Uint8Array(ciphertext))}`;
  }
  async open(value: string, expectedScope?: string): Promise<string> {
    if (!value.startsWith(prefix)) return value;
    const parts = value.split(":");
    if (parts.length !== 6 || !parts[2] || !parts[3] || !parts[4] || !parts[5])
      throw new Error("InvalidPrivateEnvelope");
    const scope = decoder.decode(decode(parts[3]));
    if (expectedScope !== undefined && scope !== expectedScope)
      throw new Error("PrivateScopeMismatch");
    const header = parts.slice(0, 4).join(":");
    try {
      return decoder.decode(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: decode(parts[4]), additionalData: encoder.encode(header) },
          await this.key(parts[2], scope),
          decode(parts[5]),
        ),
      );
    } catch {
      throw new Error("PrivateDecryptionFailed");
    }
  }
  async reveal<T>(value: T): Promise<T> {
    if (typeof value === "string") {
      if (value.startsWith(prefix)) return (await this.open(value)) as T;
      // SQLite triggers may copy protected values into JSON event metadata.
      if ((value.startsWith("{") || value.startsWith("[")) && value.includes(prefix)) {
        return JSON.stringify(await this.reveal(JSON.parse(value))) as T;
      }
    }
    if (Array.isArray(value)) return (await Promise.all(value.map((v) => this.reveal(v)))) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(
        await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await this.reveal(v)])),
      ) as T;
    return value;
  }
}
class PrivateIndex {
  constructor(readonly value: string) {}
}
export const privateIndex = (db: D1Database, value: string): unknown =>
  (db as unknown as Record<symbol, unknown>)[protectedDatabase] ? new PrivateIndex(value) : value;
class PrivateText {
  constructor(readonly value: string | null | undefined) {}
}
/** Explicit at every business write. Null and empty absence retain their meaning. */
const protectedDatabase = Symbol("privateDatabase");
export const privateText = (db: D1Database, value: string | null | undefined): unknown =>
  (db as unknown as Record<symbol, unknown>)[protectedDatabase]
    ? new PrivateText(value)
    : (value ?? null);
export function privateDatabase(
  raw: D1Database,
  cipher?: PrivateCipher,
  scope = "platform",
  decryptResults = true,
): D1Database {
  class Statement {
    constructor(
      readonly sql: string,
      readonly values: unknown[] = [],
    ) {}
    bind(...values: unknown[]) {
      return new Statement(this.sql, values);
    }
    async physical() {
      const values = await Promise.all(
        this.values.map((v) =>
          v instanceof PrivateIndex
            ? cipher
              ? cipher.index(v.value)
              : v.value
            : v instanceof PrivateText
              ? v.value
                ? cipher
                  ? cipher.seal(v.value, scope)
                  : v.value
                : (v.value ?? null)
              : v,
        ),
      );
      return raw.prepare(this.sql).bind(...values);
    }
    async all<T>() {
      const result = await (await this.physical()).all<T>();
      return cipher && decryptResults
        ? { ...result, results: await cipher.reveal(result.results) }
        : result;
    }
    async first<T>(column?: string) {
      const stmt = await this.physical();
      const value = column === undefined ? await stmt.first<T>() : await stmt.first<T>(column);
      return cipher && decryptResults ? cipher.reveal(value) : value;
    }
    async run<T>() {
      const result = await (await this.physical()).run<T>();
      return cipher && decryptResults
        ? { ...result, results: await cipher.reveal(result.results) }
        : result;
    }
    async raw<T>() {
      const result = await (await this.physical()).raw<T>();
      return cipher && decryptResults ? cipher.reveal(result) : result;
    }
  }
  return {
    [protectedDatabase]: true,
    prepare: (sql: string) => new Statement(sql),
    batch: async <T>(statements: Statement[]) => {
      const result = await raw.batch<T>(await Promise.all(statements.map((s) => s.physical())));
      return cipher && decryptResults
        ? Promise.all(result.map(async (r) => ({ ...r, results: await cipher.reveal(r.results) })))
        : result;
    },
  } as unknown as D1Database;
}
const cached = new Map<string, PrivateCipher>();
export function privateCipher(env: {
  PII_ENCRYPTION_KEYS?: string;
  PII_REQUIRED?: string;
  PII_HASH_KEY?: string;
}): PrivateCipher | undefined {
  if (!env.PII_ENCRYPTION_KEYS) {
    if (env.PII_REQUIRED === "true") throw new Error("PrivateKeyRequired");
    return undefined;
  }
  const cacheKey = env.PII_ENCRYPTION_KEYS + ":" + (env.PII_HASH_KEY ?? "");
  let cipher = cached.get(cacheKey);
  if (!cipher) {
    cipher = new PrivateCipher(env.PII_ENCRYPTION_KEYS, env.PII_HASH_KEY);
    cached.set(cacheKey, cipher);
  }
  return cipher;
}
