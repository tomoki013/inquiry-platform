// The project-facing contract and vocabulary, re-exported so the platform
// speaks of them by the same names.
export type {
  ContactReceipt,
  ContactSubmission,
  EvidenceReceipt,
  IntakeApi,
  IntakeBinding,
  IntakeProps,
  OperatorProject,
  OperatorRef,
  OperatorTicketChange,
  OperatorTicketDetail,
  OperatorTicketPage,
  OperatorTicketQuery,
  OperatorTicketSummary,
  OperatorTimelineItem,
  ProjectOperatorApi,
  ProjectOperatorProps,
  PublicTicketStatus,
  PublicTicketType,
  ReportReceipt,
  ReportSubmission,
} from "@inquiry-platform/sdk";
export { toPublicStatus, toPublicType } from "@inquiry-platform/sdk";
export * from "./api";
export * from "./apps";
export * from "./audit";
export * from "./authorization";
export * from "./branding";
export * from "./core";
export * from "./dashboard";
export * from "./errors";
export * from "./ids";
export * from "./intake";
export * from "./moderation";
export * from "./notifications";
export * from "./reply";
export * from "./reports";
export * from "./support";
export * from "./tickets";
