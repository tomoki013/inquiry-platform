/**
 * Who may do what in the platform API.
 *
 * One table, pure, and independent of how a person signed in: the admin
 * gateway turns an Access token into an {@link AdminRole} at its edge and asks
 * {@link can} before any route runs. A client may hide a control with the same
 * function, but hiding is a courtesy — the Worker's answer is the rule.
 *
 * - `viewer` reads everything and manages only their own notification devices.
 * - `operator` also works tickets: replies, notes, support status, moderation review.
 * - `admin` also changes what every operator works with: projects, masters,
 *   reply templates, signatures and moderation decisions.
 */
export const adminRoles = ["viewer", "operator", "admin", "support", "moderator"] as const;
export type AdminRole = (typeof adminRoles)[number];

export type AdminPermission =
  | "support:read"
  | "support:reply"
  | "support:manage"
  | "moderation:read"
  | "moderation:review"
  | "moderation:decide"
  | "audit:read"
  | "platform:configure"
  | "self:notifications"
  // Compatibility permissions for aggregate endpoints containing both domains.
  | "tickets:read"
  | "tickets:operate";

const read: AdminPermission[] = [
  "support:read",
  "moderation:read",
  "audit:read",
  "tickets:read",
  "self:notifications",
];
const operate: AdminPermission[] = [
  ...read,
  "support:reply",
  "support:manage",
  "moderation:review",
  "tickets:operate",
];
const granted: Record<AdminRole, ReadonlySet<AdminPermission>> = {
  viewer: new Set(read),
  operator: new Set(operate),
  admin: new Set([...operate, "moderation:decide", "platform:configure"]),
  support: new Set(["support:read", "support:reply", "support:manage", "self:notifications"]),
  moderator: new Set([
    "moderation:read",
    "moderation:review",
    "moderation:decide",
    "audit:read",
    "self:notifications",
  ]),
};

export function permissionsForRole(role: AdminRole): AdminPermission[] {
  return [...(granted[role] ?? [])];
}

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
  if (READ_METHODS.has(verb)) {
    if (/^\/api\/activity(?:\/|$)/.test(pathname)) return "audit:read";
    if (/^\/api\/reports(?:\/|$)/.test(pathname)) return "moderation:read";
    if (/^\/api\/support(?:\/|$)/.test(pathname)) return "support:read";
    if (["/api", "/api/session"].includes(pathname) || /^\/api\/apps(?:\/|$)/.test(pathname))
      return "self:notifications";
    return "tickets:read";
  }
  if (!WRITE_METHODS.has(verb)) return null;
  if (CONFIGURATION_PATHS.some((pattern) => pattern.test(pathname))) return "platform:configure";
  if (/^\/api\/reports\/[^/]+\/(?:decision|resolution|status)(?:\/|$)/.test(pathname))
    return "moderation:decide";
  if (/^\/api\/reports(?:\/|$)/.test(pathname)) return "moderation:review";
  if (/^\/api\/support\/threads\/[^/]+\/(?:reply|draft|apply-template)(?:\/|$)/.test(pathname))
    return "support:reply";
  if (/^\/api\/support(?:\/|$)/.test(pathname)) return "support:manage";
  return "tickets:operate";
}
