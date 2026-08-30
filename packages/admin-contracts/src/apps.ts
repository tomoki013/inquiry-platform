import { z } from "zod";

/**
 * Registered Studio apps.
 *
 * A closed list of statuses rather than free text: the Dashboard groups by it
 * and the Apps list colours by it, and "TestFlight" spelled three ways is three
 * groups. Adding a status is a schema change on purpose.
 */
export const appStatuses = [
  "development",
  "testflight",
  "review",
  "live",
  "paused",
  "retired",
] as const;
export type AppStatus = (typeof appStatuses)[number];

export const appPlatforms = ["ios", "web", "ios-web"] as const;
export type AppPlatform = (typeof appPlatforms)[number];

/** Link kinds the UI knows how to label. `other` keeps the list open without
 * letting it become free text in the database. */
export const appLinkTypes = [
  "brand",
  "support",
  "privacy",
  "terms",
  "app_store",
  "github",
  "backend",
  "other",
] as const;
export type AppLinkType = (typeof appLinkTypes)[number];

const slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase words joined by hyphens");

/**
 * Only `https`, and never a URL carrying a credential.
 *
 * `localhost` is allowed when the caller says the environment is not
 * production, so a development seed can point at a dev server without the
 * production schema having to permit plain http.
 */
export function appUrlSchema(options: { allowLocalhost?: boolean } = {}) {
  return z
    .string()
    .trim()
    .max(2048)
    .refine((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      if (url.username || url.password) return false;
      if (url.protocol === "https:") return true;
      return (
        options.allowLocalhost === true &&
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1")
      );
    }, "must be an https URL without credentials");
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional();

export const createAppInputSchema = z.object({
  slug,
  name: z.string().trim().min(1).max(120),
  platform: z.enum(appPlatforms),
  status: z.enum(appStatuses),
  description: optionalText(2000),
  bundleId: optionalText(200),
  publicUrl: appUrlSchema().optional(),
  supportUrl: appUrlSchema().optional(),
  appStoreUrl: appUrlSchema().optional(),
});
export type CreateAppInput = z.infer<typeof createAppInputSchema>;

/** Everything but `slug`, which is the stable handle other tables were seeded
 * against and the one field a rename must not touch. */
export const updateAppInputSchema = createAppInputSchema.omit({ slug: true }).partial();
export type UpdateAppInput = z.infer<typeof updateAppInputSchema>;

export const createAppLinkInputSchema = z.object({
  appId: z.string().min(1),
  type: z.enum(appLinkTypes),
  label: z.string().trim().min(1).max(120),
  url: appUrlSchema(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
export type CreateAppLinkInput = z.infer<typeof createAppLinkInputSchema>;

export interface AppLink {
  id: string;
  appId: string;
  type: AppLinkType;
  label: string;
  url: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  platform: AppPlatform;
  status: AppStatus;
  openReports: number;
  openSupport: number;
  updatedAt: string;
  archivedAt?: string;
}

export interface AppDetail extends Omit<AppSummary, "openReports" | "openSupport"> {
  description?: string;
  bundleId?: string;
  publicUrl?: string;
  supportUrl?: string;
  appStoreUrl?: string;
  createdAt: string;
  links: AppLink[];
  openReports: number;
  openSupport: number;
}

export const listAppsInputSchema = z
  .object({
    includeArchived: z.boolean().default(false),
  })
  .default({ includeArchived: false });
export type ListAppsInput = z.infer<typeof listAppsInputSchema>;
