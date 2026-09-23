import { describe, expect, it } from "vitest";
import { ModerationRegistry } from "../src/domain/moderation";

const adapter = {
  prepare: async () => ({ id: "p", payload: "{}", keyID: "k", decision: "delete" as const }),
  complete: async () => ({ revision: 1 }),
};

describe("ModerationRegistry", () => {
  it("resolves each listed project to the binding it names", () => {
    const registry = ModerationRegistry.fromEnv(
      { remeet: "REMEET_MODERATION" },
      { REMEET_MODERATION: adapter },
    );
    expect(registry.requiresSignedDecision("remeet")).toBe(true);
    expect(registry.adapterFor("remeet")).toBe(adapter);
  });

  it("keeps a listed project signed-only when its binding is missing", () => {
    const registry = ModerationRegistry.fromEnv({ remeet: "REMEET_MODERATION" }, {});
    expect(registry.requiresSignedDecision("remeet")).toBe(true);
    expect(registry.adapterFor("remeet")).toBeUndefined();
  });

  it("treats an unlisted project, and a malformed config, as label-closable", () => {
    for (const config of [undefined, null, "remeet", { remeet: 1 }]) {
      const registry = ModerationRegistry.fromEnv(config, { REMEET_MODERATION: adapter });
      expect(registry.requiresSignedDecision("remeet")).toBe(false);
    }
    expect(ModerationRegistry.none.requiresSignedDecision("colorvia")).toBe(false);
  });
});
