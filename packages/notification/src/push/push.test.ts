import { describe, expect, it, vi } from "vitest";
import { decodeBase64Url, encodeBase64Url, utf8 } from "./base64url";
import { encryptPayload } from "./encrypt";
import { sendWebPush } from "./send";
import { generateVapidKeys, importVapid } from "./vapid";

/**
 * RFC 8291, Appendix A — the worked example.
 *
 * Every input below is copied from the RFC, and the expected output is the
 * RFC's. Passing this is the difference between "the bytes are what a browser
 * will decrypt" and "the request returned 201 and the phone stayed silent",
 * which is the failure mode a push integration actually has: the push service
 * accepts anything well-formed, and only the device knows whether the key
 * derivation was right.
 */
const vector = {
  plaintext: "When I grow up, I want to be a watermelon",
  receiverPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  receiverAuth: "BTBZMqHH6r4Tts7J_aSIgg",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  senderPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function senderKeyPair(): Promise<CryptoKeyPair> {
  const publicRaw = decodeBase64Url(vector.senderPublic);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(publicRaw.slice(1, 33)),
    y: encodeBase64Url(publicRaw.slice(33, 65)),
  };
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  return {
    publicKey: await crypto.subtle.importKey("jwk", jwk, algorithm, true, []),
    privateKey: await crypto.subtle.importKey(
      "jwk",
      { ...jwk, d: vector.senderPrivate },
      algorithm,
      false,
      ["deriveBits"],
    ),
  };
}

describe("encryptPayload", () => {
  it("reproduces the RFC 8291 Appendix A ciphertext byte for byte", async () => {
    const body = await encryptPayload(
      utf8(vector.plaintext),
      { p256dh: vector.receiverPublic, auth: vector.receiverAuth },
      { salt: decodeBase64Url(vector.salt), senderKeyPair: await senderKeyPair() },
    );
    expect(encodeBase64Url(body)).toBe(vector.expected);
  });

  it("uses a fresh salt and sender key per message", async () => {
    const keys = { p256dh: vector.receiverPublic, auth: vector.receiverAuth };
    const first = await encryptPayload(utf8("x"), keys);
    const second = await encryptPayload(utf8("x"), keys);
    expect(encodeBase64Url(first)).not.toBe(encodeBase64Url(second));
    // Header: 16-byte salt, rs = 4096, 65-byte sender key.
    expect(new DataView(first.buffer).getUint32(16)).toBe(4096);
    expect(first[20]).toBe(65);
  });

  it("refuses keys that are not a P-256 point and a 16-byte secret", async () => {
    await expect(
      encryptPayload(utf8("x"), { p256dh: "AAAA", auth: vector.receiverAuth }),
    ).rejects.toThrow(/not a valid P-256/);
    await expect(
      encryptPayload(utf8("x"), { p256dh: vector.receiverPublic, auth: "AAAA" }),
    ).rejects.toThrow(/not a valid P-256/);
  });
});

describe("VAPID", () => {
  it("signs an ES256 token over the push service origin that the public key verifies", async () => {
    const keys = await generateVapidKeys();
    const signer = await importVapid({ ...keys, subject: "mailto:support@tmkch.io" });
    const header = await signer.authorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      new Date("2026-09-21T00:00:00Z"),
    );
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    if (!match) throw new Error(`unexpected header ${header}`);
    const [, token, k] = match as unknown as [string, string, string];
    expect(k).toBe(keys.publicKey);

    const [h, c, s] = token.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(h)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64Url(c))) as Record<
      string,
      unknown
    >;
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:support@tmkch.io");
    expect(claims.exp).toBe(Math.floor(Date.parse("2026-09-21T12:00:00Z") / 1000));

    const publicKey = await crypto.subtle.importKey(
      "raw",
      decodeBase64Url(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        decodeBase64Url(s),
        utf8(`${h}.${c}`),
      ),
    ).toBe(true);
  });

  it("refuses a subject that is not mailto: or https:", async () => {
    const keys = await generateVapidKeys();
    await expect(importVapid({ ...keys, subject: "support@tmkch.io" })).rejects.toThrow(/mailto/);
  });
});

describe("sendWebPush", () => {
  const target = {
    endpoint: "https://push.example/send/abc",
    p256dh: vector.receiverPublic,
    auth: vector.receiverAuth,
  };

  async function signer() {
    return importVapid({ ...(await generateVapidKeys()), subject: "mailto:support@tmkch.io" });
  }

  it("posts an aes128gcm body with the VAPID header and a TTL", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 201 }));
    const result = await sendWebPush(target, '{"type":"x"}', await signer(), {
      fetcher: fetcher as never,
    });
    expect(result).toEqual({ ok: true, status: 201 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(target.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("86400");
    // The payload never travels in the clear.
    expect(new TextDecoder().decode(init.body as Uint8Array)).not.toContain('"type"');
  });

  it("reports 404 and 410 as a dead subscription and everything else as a failure", async () => {
    const s = await signer();
    for (const status of [404, 410]) {
      const result = await sendWebPush(target, "x", s, {
        fetcher: (async () => new Response(null, { status })) as never,
      });
      expect(result).toEqual({ ok: false, gone: true, status });
    }
    expect(
      await sendWebPush(target, "x", s, {
        fetcher: (async () => new Response(null, { status: 429 })) as never,
      }),
    ).toEqual({ ok: false, gone: false, status: 429, reason: "rejected" });
    expect(
      await sendWebPush(target, "x", s, {
        fetcher: (async () => {
          throw new TypeError("offline");
        }) as never,
      }),
    ).toEqual({ ok: false, gone: false, reason: "transport" });
  });

  it("treats keys that cannot encrypt as a dead subscription rather than throwing", async () => {
    const fetcher = vi.fn();
    const result = await sendWebPush({ ...target, auth: "bad" }, "x", await signer(), {
      fetcher: fetcher as never,
    });
    expect(result).toEqual({ ok: false, gone: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
