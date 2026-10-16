import { beforeAll, beforeEach, expect, it } from "vitest";
import { SupportRepository } from "../src/db/support";
import { TicketService } from "../src/domain/ticket-service";
import { findReceiptReplyThread } from "../src/domain/ticket-threading";
import { PrivateCipher, privateDatabase } from "../src/privacy/crypto";
import { privateBucket } from "../src/privacy/files";
import { type Harness, harness, reset, seedApp, testEnv } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
beforeEach(reset);
const keys = "test1:fo7nSQUnihDRS_AnJtn82f9hSXWpfl7S84QkzKdFqic";
it("protects the support, case, draft and history copies and preserves search and sender checks", async () => {
  const appId = await seedApp(h);
  const cipher = new PrivateCipher(keys);
  const db = privateDatabase(testEnv.DB, cipher, appId);
  const repo = new SupportRepository(db);
  const id = crypto.randomUUID(),
    at = new Date().toISOString();
  await db.batch([
    repo.insertThreadStatement({
      id,
      appId,
      source: "web_form",
      requesterEmail: "person@example.test",
      requesterName: "Private Person",
      subject: "Private subject",
      at,
    }),
    repo.insertMessageStatement({
      id: crypto.randomUUID(),
      threadId: id,
      direction: "inbound",
      sender: "person@example.test",
      bodyText: "Private message body",
      at,
    }),
  ]);
  await repo.saveDraft(id, "Private draft");
  const raw = await testEnv.DB.prepare(
    "SELECT t.*,m.body_text FROM support_threads t JOIN support_messages m ON m.thread_id=t.id WHERE t.id=?",
  )
    .bind(id)
    .first();
  expect(JSON.stringify(raw)).not.toContain("Private");
  expect(JSON.stringify(raw)).not.toContain("person@example.test");
  expect((await repo.detail(id))?.messages[0]?.bodyText).toBe("Private message body");
  expect((await repo.draft(id))?.bodyText).toBe("Private draft");
  const tickets = new TicketService(db);
  const found = await tickets.list({ query: "Private message" });
  expect(found.ok).toBe(true);
  if (found.ok) expect(found.value.total).toBe(1);
  expect(
    await findReceiptReplyThread(db, {
      from: "person@example.test",
      subject: `[受付ID:${id}]`,
      bodyText: "",
    }),
  ).toBe(id);
  expect(
    await findReceiptReplyThread(db, {
      from: "stranger@example.test",
      subject: `[受付ID:${id}]`,
      bodyText: "",
    }),
  ).toBeNull();
  const copies = await testEnv.DB.prepare("SELECT subject,requester_email FROM tickets WHERE id=?")
    .bind(id)
    .first();
  expect(JSON.stringify(copies)).not.toContain("Private");
});
it("authenticates ciphertext, retains old keys and separates project derivation", async () => {
  const cipher = new PrivateCipher(keys);
  const value = await cipher.seal("private", "project:a");
  expect(await cipher.open(value, "project:a")).toBe("private");
  await expect(cipher.open(value, "project:b")).rejects.toThrow();
  const rotated = new PrivateCipher("test2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA," + keys);
  expect(await rotated.open(value)).toBe("private");
  await expect(
    cipher.open(
      value.slice(0, value.lastIndexOf(":") + 1) +
        (value[value.lastIndexOf(":") + 1] === "A" ? "B" : "A") +
        value.slice(value.lastIndexOf(":") + 2),
    ),
  ).rejects.toThrow();
});
it("protects attachments and original-mail metadata and refuses object swapping", async () => {
  const cipher = new PrivateCipher(keys);
  const files = privateBucket(testEnv.PRIVATE_FILES, cipher);
  const key = "support/test/secret";
  await files.put(key, "private mail body", {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { to: "person@example.test", createdAt: new Date().toISOString() },
  });
  const stored = await testEnv.PRIVATE_FILES.get(key);
  expect(await stored!.text()).not.toContain("private mail body");
  expect(JSON.stringify(stored!.customMetadata)).not.toContain("person@example.test");
  const read = await files.get(key);
  expect(await read!.text()).toBe("private mail body");
  expect(read!.customMetadata!.to).toBe("person@example.test");
  expect(read!.httpMetadata!.contentType).toBe("message/rfc822");
  await testEnv.PRIVATE_FILES.put(
    key + "-swapped",
    await (await testEnv.PRIVATE_FILES.get(key))!.arrayBuffer(),
    { customMetadata: stored!.customMetadata },
  );
  await expect(files.get(key + "-swapped")).rejects.toThrow();
});
it("decrypts only once through the registry/aggregate adapters", async () => {
  const { buildServices } = await import("../src/services");
  const appId = await seedApp(h);
  const cipher = new PrivateCipher(keys);
  const foreign = await cipher.seal("must never reveal", "another-project");
  const services = buildServices(
    { ...testEnv, PII_ENCRYPTION_KEYS: keys, PII_REQUIRED: "true" },
    () => {},
  );
  const database = await services.registry.forProject(appId);
  const repo = new SupportRepository(database);
  const id = crypto.randomUUID();
  await database.batch([
    repo.insertThreadStatement({
      id,
      appId,
      source: "web_form",
      requesterEmail: "person@example.test",
      subject: foreign,
      at: new Date().toISOString(),
    }),
  ]);
  expect((await repo.detail(id))!.subject).toBe(foreign);
});
it("protects push destinations and preserves stable resubscription ownership", async () => {
  const { NotificationRepository } = await import("../src/db/notifications");
  const { privateCipher } = await import("../src/privacy/crypto");
  const cipher = privateCipher({
    PII_ENCRYPTION_KEYS: keys,
    PII_HASH_KEY: "mGwI7beShqXywjxI1YFnQr+oubt8YMwKbu3lhy3u9vQ=",
    PII_REQUIRED: "true",
  });
  const db = privateDatabase(testEnv.DB, cipher);
  const repo = new NotificationRepository(db);
  const input = {
    id: crypto.randomUUID(),
    adminUserId: "operator@example.test",
    endpoint: "https://push.example.test/private-credential",
    p256dh: "private-browser-key",
    auth: "private-auth",
    deviceName: "Private Device",
    at: new Date().toISOString(),
  };
  await db.batch([repo.upsertStatement(input)]);
  await db.batch([repo.upsertStatement({ ...input, auth: "updated-private-auth" })]);
  const raw = (await testEnv.DB.prepare("SELECT * FROM push_subscriptions").all()).results;
  expect(raw).toHaveLength(1);
  expect(JSON.stringify(raw)).not.toContain("private-credential");
  expect(JSON.stringify(raw)).not.toContain("private-browser-key");
  expect(JSON.stringify(raw)).not.toContain("Private Device");
  expect((await repo.findByEndpoint(input.endpoint))?.auth).toBe("updated-private-auth");
  expect((await repo.deliverable())[0]?.endpoint).toBe(input.endpoint);
});
it("migrates active and sealed legacy copies without dropping the old write fence", async () => {
  const { storageMigration, sealStorageSql } = await import("../src/storage/migration");
  const { storageTables } = await import("../src/storage/schema");
  const { splitMigration } = await import("./harness");
  const { migratePrivateStorage } = await import("../src/privacy/maintenance");
  const db = testEnv.DB;
  const appId = await seedApp(h);
  const id = crypto.randomUUID();
  const repo = new SupportRepository(db);
  await db.batch([
    repo.insertThreadStatement({
      id,
      appId,
      source: "web_form",
      requesterEmail: "private@example.test",
      subject: "Private migration",
      at: new Date().toISOString(),
    }),
  ]);
  const objects = (
    await db
      .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL")
      .all<import("../src/storage/migration").SchemaObject>()
  ).results;
  const columns = {} as import("../src/storage/migration").StorageSchema["columns"];
  for (const table of storageTables)
    columns[table] = (
      await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    ).results.map((r) => r.name);
  const plan = storageMigration({ objects, columns }, { slug: "orbit", prefix: "p_privacytest" });
  await db.prepare("UPDATE services SET is_active=0 WHERE id<>?").bind(appId).run();
  for (const sql of [plan.prepare, plan.copy, plan.cutover, sealStorageSql()])
    await db.batch(splitMigration(sql).map((s) => db.prepare(s)));
  const env = { ...testEnv, PII_ENCRYPTION_KEYS: keys, PII_REQUIRED: "true" };
  let done = false;
  for (let i = 0; i < 40; i++) {
    const result = await migratePrivateStorage(env, "orbit");
    if (result.done) {
      done = true;
      break;
    }
  }
  expect(done).toBe(true);
  for (const table of ["support_threads", "p_privacytest_support_tickets"]) {
    const row = await db
      .prepare(`SELECT requester_email,subject FROM ${table} WHERE id=?`)
      .bind(id)
      .first();
    expect(JSON.stringify(row)).not.toContain("private@example.test");
    expect(JSON.stringify(row)).not.toContain("Private migration");
  }
  await expect(
    db.prepare("UPDATE support_threads SET subject='plain' WHERE id=?").bind(id).run(),
  ).rejects.toThrow();
  await expect(
    db
      .prepare("UPDATE p_privacytest_support_tickets SET subject='plain' WHERE id=?")
      .bind(id)
      .run(),
  ).rejects.toThrow("PrivateCiphertextRequired");
  const { buildServices } = await import("../src/services");
  const services = buildServices(env, () => {});
  const privateDb = await services.registry.forProject(appId);
  expect((await new SupportRepository(privateDb).detail(id))!.subject).toBe("Private migration");
});
