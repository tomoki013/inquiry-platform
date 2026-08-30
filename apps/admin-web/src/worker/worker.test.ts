import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminWebEnv } from "./env";
import { createApp } from "./index";

/**
 * The gate, and the guards behind it.
 *
 * These tests mint real RS256 tokens and serve a real JWKS, because the thing
 * being asserted is that `jose` verifies signature, issuer, audience and expiry
 * — not that a hand-written parser reads the claims we expected. A test with a
 * stubbed verifier would pass against a Worker that checks nothing.
 */

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };

const AUD = "aud-tag-for-tomokichi-admin";
let domainCounter = 0;

/** A fresh team domain per test: `createRemoteJWKSet` is cached per domain, on
 * purpose, and reusing one would have a later test verifying against an earlier
 * test's keys. */
function newDomain(): string {
  domainCounter += 1;
  return `team${domainCounter}.cloudflareaccess.com`;
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, alg: "RS256", kid: "test-key" }] };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function serveJwks(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/cdn-cgi/access/certs")) {
      return new Response(JSON.stringify(jwks), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

async function token(options: {
  domain: string;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
}): Promise<string> {
  return await new SignJWT({ email: "operator@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("access-subject-id")
    .setIssuedAt()
    .setIssuer(options.issuer ?? `https://${options.domain}`)
    .setAudience(options.audience ?? AUD)
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(privateKey);
}

const coreStub = {
  mailProviderConfigured: () => Promise.resolve(true),
  getDashboard: () =>
    Promise.resolve({ ok: true, value: { openReports: 1, apps: [], recentActivity: [] } }),
  changeReportStatus: () => Promise.resolve({ ok: true, value: { id: "r1" } }),
} as unknown as AdminWebEnv["ADMIN_CORE"];

function env(overrides: Partial<AdminWebEnv> = {}): AdminWebEnv {
  return {
    ADMIN_CORE: coreStub,
    ASSETS: {
      fetch: () => Promise.resolve(new Response("<html>app</html>")),
    } as unknown as Fetcher,
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    ADMIN_ORIGIN: "https://admin.tmkch.io",
    ENVIRONMENT: "production",
    ...overrides,
  };
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://admin.tmkch.io${path}`, { headers });
}

describe("Cloudflare Access", () => {
  it("refuses a request with no token", async () => {
    const response = await createApp().fetch(
      get("/api/dashboard"),
      env({ ACCESS_TEAM_DOMAIN: newDomain(), ACCESS_AUD: AUD }),
      ctx,
    );
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNAUTHORIZED",
    );
  });

  it("refuses a token that is not a token", async () => {
    serveJwks();
    const response = await createApp().fetch(
      get("/api/dashboard", { "Cf-Access-Jwt-Assertion": "not.a.jwt" }),
      env({ ACCESS_TEAM_DOMAIN: newDomain(), ACCESS_AUD: AUD }),
      ctx,
    );
    expect(response.status).toBe(401);
  });

  /** The check that catches a valid token minted for a different application. */
  it("refuses a token with the wrong audience", async () => {
    serveJwks();
    const domain = newDomain();
    const response = await createApp().fetch(
      get("/api/dashboard", {
        "Cf-Access-Jwt-Assertion": await token({ domain, audience: "some-other-app" }),
      }),
      env({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: AUD }),
      ctx,
    );
    expect(response.status).toBe(401);
  });

  it("refuses a token from the wrong issuer", async () => {
    serveJwks();
    const domain = newDomain();
    const response = await createApp().fetch(
      get("/api/dashboard", {
        "Cf-Access-Jwt-Assertion": await token({ domain, issuer: "https://evil.example.com" }),
      }),
      env({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: AUD }),
      ctx,
    );
    expect(response.status).toBe(401);
  });

  it("refuses an expired token", async () => {
    serveJwks();
    const domain = newDomain();
    const response = await createApp().fetch(
      get("/api/dashboard", {
        "Cf-Access-Jwt-Assertion": await token({ domain, expiresIn: "-1h" }),
      }),
      env({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: AUD }),
      ctx,
    );
    expect(response.status).toBe(401);
  });

  it("accepts a valid token, and accepts it from the cookie too", async () => {
    serveJwks();
    const domain = newDomain();
    const jwt = await token({ domain });
    const configured = env({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: AUD });

    const viaHeader = await createApp().fetch(
      get("/api/dashboard", { "Cf-Access-Jwt-Assertion": jwt }),
      configured,
      ctx,
    );
    expect(viaHeader.status).toBe(200);

    const viaCookie = await createApp().fetch(
      get("/api/dashboard", { Cookie: `CF_Authorization=${jwt}` }),
      configured,
      ctx,
    );
    expect(viaCookie.status).toBe(200);
  });

  /**
   * The most important negative case in this file: an unconfigured production
   * deployment refuses everything. "Access is in front of this hostname" is a
   * dashboard setting; a Worker that falls open when it cannot verify is a
   * Worker that is open the day somebody points a preview URL at it.
   */
  it("refuses everything when Access is not configured in production", async () => {
    const response = await createApp().fetch(get("/api/dashboard"), env(), ctx);
    expect(response.status).toBe(401);
  });

  it("also refuses the client bundle, not only the API", async () => {
    const response = await createApp().fetch(get("/"), env(), ctx);
    expect(response.status).toBe(401);
  });

  it("allows a named developer only when the deployment says it is local", async () => {
    const local = env({ ENVIRONMENT: "local", DEV_ADMIN_EMAIL: "dev@example.com" });
    expect((await createApp().fetch(get("/api/dashboard"), local, ctx)).status).toBe(200);

    // The same variables in production change nothing.
    const production = env({ ENVIRONMENT: "production", DEV_ADMIN_EMAIL: "dev@example.com" });
    expect((await createApp().fetch(get("/api/dashboard"), production, ctx)).status).toBe(401);
  });
});

describe("mutation guard", () => {
  const local = () => env({ ENVIRONMENT: "local", DEV_ADMIN_EMAIL: "dev@example.com" });

  const post = (headers: Record<string, string>) =>
    new Request("https://admin.tmkch.io/api/reports/r1/status", {
      method: "POST",
      headers,
      body: JSON.stringify({ to: "reviewing" }),
    });

  it("refuses a state change with no Origin", async () => {
    const response = await createApp().fetch(
      post({ "Content-Type": "application/json" }),
      local(),
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it("refuses a state change from another origin", async () => {
    const response = await createApp().fetch(
      post({ "Content-Type": "application/json", Origin: "https://evil.example.com" }),
      local(),
      ctx,
    );
    expect(response.status).toBe(403);
  });

  it("refuses a form content type", async () => {
    const response = await createApp().fetch(
      post({
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "http://localhost:4330",
      }),
      local(),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it("allows a same-origin JSON request", async () => {
    const response = await createApp().fetch(
      post({ "Content-Type": "application/json", Origin: "http://localhost:4330" }),
      local(),
      ctx,
    );
    expect(response.status).toBe(200);
  });

  it("does not gate reads", async () => {
    const response = await createApp().fetch(get("/api/dashboard"), local(), ctx);
    expect(response.status).toBe(200);
  });
});

describe("security headers", () => {
  it("are on every response, including refused ones", async () => {
    for (const response of [
      await createApp().fetch(get("/api/dashboard"), env(), ctx),
      await createApp().fetch(
        get("/api/dashboard"),
        env({ ENVIRONMENT: "local", DEV_ADMIN_EMAIL: "dev@example.com" }),
        ctx,
      ),
    ]) {
      const csp = response.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      // No inline script, ever.
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    }
  });

  it("never sends a CORS allow header", async () => {
    const response = await createApp().fetch(
      get("/api/dashboard", { Origin: "https://evil.example.com" }),
      env({ ENVIRONMENT: "local", DEV_ADMIN_EMAIL: "dev@example.com" }),
      ctx,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("keeps API responses out of any cache", async () => {
    const response = await createApp().fetch(
      get("/api/dashboard"),
      env({ ENVIRONMENT: "local", DEV_ADMIN_EMAIL: "dev@example.com" }),
      ctx,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("unknown API paths", () => {
  it("are a 404 with a request id, not a stack trace", async () => {
    const response = await createApp().fetch(
      get("/api/nope"),
      env({ ENVIRONMENT: "local", DEV_ADMIN_EMAIL: "dev@example.com" }),
      ctx,
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string }; requestId: string };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("at ");
  });
});
