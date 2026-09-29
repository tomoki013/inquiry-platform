import type { CreateAppInput, ReplyTemplateCategory } from "@inquiry-platform/core";

/**
 * One deployment's starting data: its Projects, reply templates, signature
 * and where contacts that belong to no Project are filed.
 *
 * The platform ships none of its own. A deployment keeps this file next to its
 * own `wrangler.jsonc` copies, outside this repository, and turns it into SQL
 * with `pnpm --filter @inquiry-platform/api seed <path>`. `seed/example.ts` is
 * a working example.
 *
 * Every field is optional, and every statement generated from it is a guarded
 * insert: re-running the seed creates nothing twice and never overwrites what
 * an operator has since edited through the Operator API.
 */
export interface DeploymentSeed {
  apps?: AppSeed[];
  replyTemplates?: ReplyTemplateSeed[];
  /** The deployment-wide signature (`app_mail_settings` with no app).
   * Appended only when sending. */
  signature?: string;
  /** Ticket services that are not Projects, for example one for contacts
   * about the operator in general rather than any one app. Projects become
   * services on their own. */
  services?: ServiceSeed[];
  /** Where a contact that names no Project is filed: a service id, from
   * `services` or a Project's id. Unset means the built-in `unassigned`. */
  defaultServiceId?: string;
  /** Project-scoped delivery addresses. These are deployment configuration,
   * not browser-editable mail settings. Re-running the seed synchronises them. */
  mailSettings?: MailSettingsSeed[];
}

export type AppSeed = CreateAppInput & {
  links?: { type: string; label: string; url: string }[];
};

export interface ReplyTemplateSeed {
  key: string;
  name: string;
  category: ReplyTemplateCategory;
  /** Slug, resolved to an id at seed time. Absent means deployment-wide. */
  appSlug?: string;
  /** The reply's subject, used only for a thread that has none of its own. */
  subject: string;
  body: string;
  includeSignature: boolean;
  sortOrder: number;
}

export interface ServiceSeed {
  id: string;
  name: string;
  slug: string;
}

export interface MailSettingsSeed {
  /** Omit for the deployment-wide fallback row. */
  appSlug?: string;
  supportEmail?: string;
  fromName?: string;
  noreplyEmail?: string;
  notificationEmail?: string;
  /** The project's own operator console, e.g.
   * `https://admin.example.com/#/inquiries/{ticketNumber}`. Notification links
   * point there instead of at the deployment-wide template. */
  ticketUrlTemplate?: string;
}
