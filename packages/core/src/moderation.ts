import { z } from "zod";

export const reportDecisionSchema = z.object({
  reportId: z.string().min(1),
  decision: z.enum(["delete", "dismiss"]),
});
export type ReportDecision = z.infer<typeof reportDecisionSchema>;
/** Defined in the SDK, because a project implements it. See
 * `ModerationAdapter` there and `SIGNED_MODERATION` in apps/api/wrangler.jsonc. */
export type {
  ModerationAdapter,
  ModerationProposal,
  ModerationRequest,
} from "@inquiry-platform/sdk";
