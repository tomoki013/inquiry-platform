import type { PublicTicketStatus, PublicTicketType } from "./types";

/**
 * The platform's internal statuses and types, and the smaller vocabulary a
 * project sees. The platform keeps the finer set because its SLA and queue
 * depend on it; a person asking "where is my request" does not.
 */
export const internalTicketStatuses = [
  "NEW",
  "TRIAGE",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "RESOLVED",
  "CLOSED",
] as const;
export type InternalTicketStatus = (typeof internalTicketStatuses)[number];

const statusMap: Record<InternalTicketStatus, PublicTicketStatus> = {
  NEW: "OPEN",
  TRIAGE: "OPEN",
  ACKNOWLEDGED: "OPEN",
  IN_PROGRESS: "IN_PROGRESS",
  WAITING_CUSTOMER: "IN_PROGRESS",
  WAITING_INTERNAL: "IN_PROGRESS",
  RESOLVED: "RESOLVED",
  CLOSED: "CLOSED",
};

export function toPublicStatus(status: InternalTicketStatus): PublicTicketStatus {
  return statusMap[status];
}

export const internalTicketTypes = [
  "INQUIRY",
  "REPORT",
  "BUG",
  "INCIDENT",
  "BILLING",
  "PRIVACY",
  "OTHER",
] as const;
export type InternalTicketType = (typeof internalTicketTypes)[number];

const typeMap: Record<InternalTicketType, PublicTicketType> = {
  INQUIRY: "contact",
  REPORT: "report",
  BUG: "bug",
  INCIDENT: "other",
  BILLING: "other",
  PRIVACY: "other",
  OTHER: "other",
};

export function toPublicType(type: InternalTicketType): PublicTicketType {
  return typeMap[type];
}
