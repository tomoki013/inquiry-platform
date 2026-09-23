import { z } from "zod";

export const reportDecisionSchema = z.object({
  reportId: z.string().min(1),
  decision: z.enum(["delete", "dismiss"]),
});
export type ReportDecision = z.infer<typeof reportDecisionSchema>;
export interface ModerationRequest {
  reportId: string;
  contentId: string;
  contentType: string;
  reunionId?: string;
  reason: string;
  decision: "delete" | "dismiss";
  actorId: string;
}
export interface ModerationProposal {
  id: string;
  payload: string;
  keyID: string;
  decision: "delete" | "dismiss";
}
/**
 * A project's own way of acting on reported content.
 *
 * The platform decides *that* a report is upheld or dismissed; only the
 * project knows how to remove its content. A project that registers an adapter
 * gets signed decisions: Core asks the adapter for a proposal, the operator
 * signs it off-platform, and the adapter publishes it. For such a project a
 * status label alone never closes a report. Registered per project slug in
 * `SIGNED_MODERATION` (apps/api/wrangler.jsonc).
 */
export interface ModerationAdapter {
  prepare(input: ModerationRequest): Promise<ModerationProposal>;
  complete(id: string, envelope: string): Promise<{ revision: number }>;
}
