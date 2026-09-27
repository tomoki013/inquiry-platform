import { describe, expect, it } from "vitest";
import { ModerationRegistry } from "../src/domain/moderation";

const adapter = {
  prepare: async () => ({ id: "p", payload: "{}", keyID: "k", decision: "delete" as const }),
  complete: async () => ({ revision: 1 }),
};

describe("ModerationRegistry", () => {
  it("resolves each listed project to the binding it names", () => {
    const registry = ModerationRegistry.fromEnv(
      { orbit: "ORBIT_MODERATION" },
      { ORBIT_MODERATION: adapter },
    );
    expect(registry.requiresSignedDecision("orbit")).toBe(true);
    expect(registry.adapterFor("orbit")).toBe(adapter);
  });

  it("keeps a listed project signed-only when its binding is missing", () => {
    const registry = ModerationRegistry.fromEnv({ orbit: "ORBIT_MODERATION" }, {});
    expect(registry.requiresSignedDecision("orbit")).toBe(true);
    expect(registry.adapterFor("orbit")).toBeUndefined();
  });

  it("treats an unlisted project, and a malformed config, as label-closable", () => {
    for (const config of [undefined, null, "orbit", { orbit: 1 }]) {
      const registry = ModerationRegistry.fromEnv(config, { ORBIT_MODERATION: adapter });
      expect(registry.requiresSignedDecision("orbit")).toBe(false);
    }
    expect(ModerationRegistry.none.requiresSignedDecision("prism")).toBe(false);
  });
});
