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
export interface RemeetModerationApi {
  prepare(input: ModerationRequest): Promise<ModerationProposal>;
  complete(id: string, envelope: string): Promise<{ revision: number }>;
}
