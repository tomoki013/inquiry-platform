import {
  type MailProvider,
  ResendMailProvider,
  UnconfiguredMailProvider,
} from "@inquiry-platform/notification/mail";
import { z } from "zod";

const configSchema = z.object({
  apiKeyBinding: z.string().regex(/^MAIL_API_KEY_[A-Z0-9_]+$/),
  defaultSignature: z.string().max(2000).default(""),
  supportUrl: z.url({ protocol: /^https$/ }).optional(),
  logo: z.object({ url: z.url({ protocol: /^https$/ }), alt: z.string().max(80) }).optional(),
  lookupMessageIds: z.boolean().default(false),
});

export interface ProjectMailDelivery {
  mail: MailProvider;
  defaultSignature?: string;
  supportUrl?: string;
}

/** Deployment-owned routing by immutable project id. Credentials live only in
 * Worker Secrets; neither the database nor an RPC request can choose a binding.
 * An explicit route never falls back to another project's credential or logo. */
export function projectMailResolver(
  raw: unknown,
  secrets: object,
  fallback: MailProvider,
  fetcher?: typeof fetch,
): (appId: string | undefined) => ProjectMailDelivery {
  const routes =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const cache = new Map<string, ProjectMailDelivery>();
  return (appId) => {
    if (!appId || !Object.hasOwn(routes, appId)) return { mail: fallback };
    const existing = cache.get(appId);
    if (existing) return existing;
    const parsed = configSchema.safeParse(routes[appId]);
    const key =
      parsed.success && Object.hasOwn(secrets, parsed.data.apiKeyBinding)
        ? (secrets as Record<string, unknown>)[parsed.data.apiKeyBinding]
        : undefined;
    const delivery: ProjectMailDelivery = {
      mail:
        parsed.success && typeof key === "string" && key.trim()
          ? new ResendMailProvider(key, fetcher, parsed.data.logo, parsed.data.lookupMessageIds)
          : new UnconfiguredMailProvider(),
      // Missing or invalid routes have no deployment branding fallback.
      defaultSignature: parsed.success ? parsed.data.defaultSignature : "",
      supportUrl: parsed.success ? parsed.data.supportUrl : undefined,
    };
    cache.set(appId, delivery);
    return delivery;
  };
}
