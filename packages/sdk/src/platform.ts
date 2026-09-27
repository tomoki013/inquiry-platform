/**
 * Client for the platform-owned operator API.
 *
 * This package contains transport only. The server remains the source of
 * truth for authz, validation, audit, privacy, and state transitions. A
 * consumer can render any UI (or none) while using the same API semantics.
 */
import type { IntakeErrorCode } from "./types";

export const PLATFORM_API_VERSION = "v1" as const;

export const standardApiCapabilities = [
  "tickets",
  "reports",
  "support",
  "reply-drafts-and-templates",
  "projects",
  "notifications",
  "activity",
  "dashboard",
] as const;

export type StandardApiCapability = (typeof standardApiCapabilities)[number];

export interface PlatformApiDescriptor {
  version: typeof PLATFORM_API_VERSION;
  capabilities: readonly StandardApiCapability[];
  implementationPolicy: "platform-owned";
  extensionPolicy: "outside-standard-surface";
  security: {
    authentication: "cloudflare-access-jwt";
    authorization: "server-side-role-permission";
    mutations: "json-only-and-csrf-protected-for-cookie-auth";
    errors: "stable-code-and-request-id";
  };
}

export const platformApiDescriptor: PlatformApiDescriptor = {
  version: PLATFORM_API_VERSION,
  capabilities: standardApiCapabilities,
  implementationPolicy: "platform-owned",
  extensionPolicy: "outside-standard-surface",
  security: {
    authentication: "cloudflare-access-jwt",
    authorization: "server-side-role-permission",
    mutations: "json-only-and-csrf-protected-for-cookie-auth",
    errors: "stable-code-and-request-id",
  },
};

export type PlatformApiSuccess<T> = {
  ok: true;
  data: T;
  requestId: string;
};

export type PlatformApiFailure = {
  ok: false;
  error: {
    code: IntakeErrorCode;
    message: string;
    fields?: Record<string, string>;
  };
  requestId: string;
};

export type PlatformApiResult<T> = PlatformApiSuccess<T> | PlatformApiFailure;

export interface PlatformApiClientOptions {
  /** The API origin, without a trailing slash. */
  origin: string;
  /** A Cloudflare Access JWT accepted by the API gateway. */
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export interface PlatformApiClient {
  /** Read the canonical capabilities and security descriptor. */
  describe(): Promise<PlatformApiResult<PlatformApiDescriptor>>;
  /**
   * Escape hatch for the standard API only. Keep application-specific
   * endpoints outside `/api/*`; the gateway intentionally rejects unknown
   * standard paths.
   */
  request<T>(path: string, init?: RequestInit): Promise<PlatformApiResult<T>>;
}

export function createPlatformApiClient(options: PlatformApiClientOptions): PlatformApiClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const origin = options.origin.replace(/\/$/, "");

  async function request<T>(path: string, init: RequestInit = {}): Promise<PlatformApiResult<T>> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (options.token) headers.set("Authorization", `Bearer ${options.token}`);

    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, { ...init, headers });
    } catch {
      return {
        ok: false,
        error: { code: "UNAVAILABLE", message: "The platform API is unavailable." },
        requestId: "unknown",
      };
    }
    const body = (await response.json().catch(() => undefined)) as PlatformApiResult<T> | undefined;
    if (body && typeof body === "object" && "ok" in body) return body;
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "The platform returned an invalid response." },
      requestId: response.headers.get("Cf-Ray") ?? "unknown",
    };
  }

  return {
    describe: () => request<PlatformApiDescriptor>("/api"),
    request,
  };
}
