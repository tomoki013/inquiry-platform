import { describe, expect, it } from "vitest";
import { adminRoles, can, isAdminRole, permissionFor } from "./authorization";

describe("can", () => {
  it("grants each role exactly its own permissions and everything below", () => {
    expect(can("viewer", "tickets:read")).toBe(true);
    expect(can("viewer", "self:notifications")).toBe(true);
    expect(can("viewer", "tickets:operate")).toBe(false);
    expect(can("viewer", "platform:configure")).toBe(false);

    expect(can("operator", "tickets:operate")).toBe(true);
    expect(can("operator", "platform:configure")).toBe(false);

    for (const permission of [
      "tickets:read",
      "tickets:operate",
      "platform:configure",
      "self:notifications",
    ] as const) {
      expect(can("admin", permission)).toBe(true);
    }
  });

  it("refuses a role it does not know", () => {
    expect(can("owner" as never, "tickets:read")).toBe(false);
    expect(isAdminRole("owner")).toBe(false);
    for (const role of adminRoles) expect(isAdminRole(role)).toBe(true);
  });
});

describe("permissionFor", () => {
  it.each([
    ["GET", "/api/tickets", "tickets:read"],
    ["GET", "/api/apps", "tickets:read"],
    ["PATCH", "/api/tickets/t1", "tickets:operate"],
    ["POST", "/api/tickets/t1/notes", "tickets:operate"],
    ["POST", "/api/support/threads/s1/reply", "tickets:operate"],
    ["POST", "/api/reports/r1/decision/prepare", "tickets:operate"],
    ["POST", "/api/tickets/masters", "platform:configure"],
    ["POST", "/api/apps", "platform:configure"],
    ["PATCH", "/api/apps/a1", "platform:configure"],
    ["DELETE", "/api/apps/links/l1", "platform:configure"],
    ["POST", "/api/support/templates", "platform:configure"],
    ["PUT", "/api/support/mail-settings", "platform:configure"],
    ["PUT", "/api/notifications/settings", "self:notifications"],
    ["DELETE", "/api/notifications/push/subscriptions/d1", "self:notifications"],
    // A route that does not exist yet is still at least an operator's write.
    ["POST", "/api/something-new", "tickets:operate"],
  ])("%s %s needs %s", (method, path, permission) => {
    expect(permissionFor(method, path)).toBe(permission);
  });

  it("does not mistake a similarly named path for configuration", () => {
    expect(permissionFor("POST", "/api/appsx")).toBe("tickets:operate");
    expect(permissionFor("POST", "/api/tickets/masters-x")).toBe("tickets:operate");
  });

  it("accepts no other method", () => {
    expect(permissionFor("OPTIONS", "/api/tickets")).toBeNull();
    expect(permissionFor("TRACE", "/api/notifications")).toBeNull();
  });
});
