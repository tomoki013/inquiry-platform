/**
 * Who may do what in the admin console.
 *
 * One table, pure, and independent of how a person signed in: the admin
 * Worker turns an Access token into an {@link AdminRole} at its edge and asks
 * {@link can} before any route runs. The UI may hide a button with the same
 * function, but hiding is a courtesy — the Worker's answer is the rule.
 *
 * - `viewer` reads everything and manages only their own notification devices.
 * - `operator` also works tickets: replies, notes, status, moderation decisions.
 * - `admin` also changes what every operator works with: projects, masters,
 *   reply templates and signatures.
 */
export const adminRoles = ["viewer", "operator", "admin"] as const;
export type AdminRole = (typeof adminRoles)[number];

export type AdminPermission =
  /** Read tickets, reports, threads, projects and the audit trail. */
  | "tickets:read"
  /** Change a ticket, reply, add a note, decide a report. */
  | "tickets:operate"
  /** Projects, ticket masters, reply templates, mail signatures. */
  | "platform:configure"
  /** The signed-in person's own notification settings and devices. */
  | "self:notifications";

const granted: Record<AdminRole, ReadonlySet<AdminPermission>> = {
  viewer: new Set(["tickets:read", "self:notifications"]),
  operator: new Set(["tickets:read", "self:notifications", "tickets:operate"]),
  admin: new Set(["tickets:read", "self:notifications", "tickets:operate", "platform:configure"]),
};

export function can(role: AdminRole, permission: AdminPermission): boolean {
  return granted[role]?.has(permission) ?? false;
}

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (adminRoles as readonly string[]).includes(value);
}

const READ_METHODS = new Set(["GET", "HEAD"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Admin API paths that change what every operator works with. */
const CONFIGURATION_PATHS = [
  /^\/api\/tickets\/masters$/,
  /^\/api\/apps(\/|$)/,
  /^\/api\/support\/templates(\/|$)/,
  /^\/api\/support\/mail-settings$/,
];

/**
 * The permission an admin API request needs, or `null` for a method the API
 * does not accept at all (refused regardless of role).
 *
 * Classified by method and path rather than declared per route so that a
 * route added later cannot be forgotten: every write is at least
 * `tickets:operate` unless it is listed as something narrower or wider here.
 */
export function permissionFor(method: string, pathname: string): AdminPermission | null {
  const verb = method.toUpperCase();
  if (pathname.startsWith("/api/notifications/") || pathname === "/api/notifications") {
    return READ_METHODS.has(verb) || WRITE_METHODS.has(verb) ? "self:notifications" : null;
  }
  if (READ_METHODS.has(verb)) return "tickets:read";
  if (!WRITE_METHODS.has(verb)) return null;
  if (CONFIGURATION_PATHS.some((pattern) => pattern.test(pathname))) return "platform:configure";
  return "tickets:operate";
}
