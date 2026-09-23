import type { ModerationAdapter } from "@inquiry-platform/core";

/**
 * Which projects act on reports through a {@link ModerationAdapter}, and the
 * adapter for each.
 *
 * Being listed is what matters for the rules: a listed project's reports can
 * only be closed by a signed decision, even while its adapter is unreachable
 * (then nothing can close them, which is the safe direction). The adapter is
 * what makes the decision possible at all.
 */
export class ModerationRegistry {
  static readonly none = new ModerationRegistry(new Map());

  constructor(private readonly adapters: ReadonlyMap<string, ModerationAdapter | undefined>) {}

  /**
   * `SIGNED_MODERATION` maps a project slug to the name of the Service
   * Binding that implements its adapter, e.g. `{ "remeet": "REMEET_MODERATION" }`.
   * A name with no binding behind it still marks the project as signed-only.
   */
  static fromEnv(config: unknown, env: object): ModerationRegistry {
    const bindings = env as Record<string, unknown>;
    const adapters = new Map<string, ModerationAdapter | undefined>();
    if (config && typeof config === "object") {
      for (const [slug, binding] of Object.entries(config)) {
        if (typeof binding !== "string") continue;
        adapters.set(slug, bindings[binding] as ModerationAdapter | undefined);
      }
    }
    return new ModerationRegistry(adapters);
  }

  requiresSignedDecision(projectSlug: string): boolean {
    return this.adapters.has(projectSlug);
  }

  adapterFor(projectSlug: string): ModerationAdapter | undefined {
    return this.adapters.get(projectSlug);
  }
}
