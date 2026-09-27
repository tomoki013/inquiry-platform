import { z } from "zod";

/**
 * What a deployment of this platform calls itself.
 *
 * None of this is logic: it is the deployment name exposed by the API, the
 * signature a reply ends with when a project has not set its own, and the
 * picture beside that signature. It lives in the deployment's configuration
 * (`BRANDING` in `apps/api/wrangler.jsonc`) so that nothing under `src/` names
 * whoever happens to run it. Per-project signatures stay where they already
 * are, in `app_mail_settings`; this is only the fallback.
 */
export const brandingSchema = z.object({
  /** Shown in API metadata and available to clients that render branding. */
  consoleName: z.string().trim().min(1).max(80).default("Inquiry Platform"),
  /** Where there is less room: a short API label. Falls back
   * to `consoleName`. */
  consoleShortName: z.string().trim().min(1).max(40).optional(),
  /** Appended to a reply when neither the project nor the deployment-wide
   * `app_mail_settings` row has a signature. Empty means none. */
  defaultSignature: z.string().max(2000).default(""),
  /**
   * Signatures an earlier version appended to drafts. Stripped from a draft
   * before the current signature is added, so a draft saved long ago does not
   * go out signed twice.
   */
  legacySignatures: z.array(z.string().max(2000)).max(20).default([]),
  /** The one `<img>` an outgoing HTML mail may carry, beside the signature. */
  mailLogo: z.object({ url: z.url({ protocol: /^https$/ }), alt: z.string().max(80) }).optional(),
  /** The project a ticket opened from the console defaults to. */
  defaultProjectId: z.string().min(1).max(64).optional(),
});

export type Branding = z.infer<typeof brandingSchema>;

/** The deployment's display names for clients that choose to render them. */
export function consoleAppName(branding: Pick<Branding, "consoleName" | "consoleShortName">): {
  name: string;
  shortName: string;
} {
  return {
    name: branding.consoleName,
    shortName: branding.consoleShortName ?? branding.consoleName,
  };
}

/**
 * Reads `BRANDING` leniently: a missing or malformed value falls back to the
 * neutral defaults rather than taking the Worker down, because every field
 * here is cosmetic.
 */
export function parseBranding(raw: unknown): Branding {
  const parsed = brandingSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : brandingSchema.parse({});
}

/** Display metadata for API consumers that choose to render a label. */
export interface ConsoleProfile {
  consoleName: string;
  consoleShortName?: string;
  /** The address replies go out from, shown in the composer. */
  replyFromAddress: string;
  /** The composer's preview when no `app_mail_settings` row applies. */
  defaultSignature: string;
  defaultProjectId?: string;
}
