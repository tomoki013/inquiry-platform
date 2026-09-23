import { z } from "zod";

export const ticketTypes = [
  "INQUIRY",
  "REPORT",
  "BUG",
  "INCIDENT",
  "BILLING",
  "PRIVACY",
  "OTHER",
] as const;
export const ticketStatuses = [
  "NEW",
  "TRIAGE",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "WAITING_CUSTOMER",
  "WAITING_INTERNAL",
  "RESOLVED",
  "CLOSED",
] as const;
export const ticketResolutions = [
  "RESOLVED",
  "NO_ACTION_REQUIRED",
  "SPAM",
  "DUPLICATE",
  "INVALID",
  "USER_WITHDREW",
  "CONTENT_REMOVED",
  "ACCOUNT_ACTIONED",
  "FIXED",
  "OTHER",
] as const;
export const ticketPriorities = ["P1", "P2", "P3", "P4"] as const;
export const ticketLevels = ["HIGH", "MEDIUM", "LOW"] as const;
export const ticketRelationTypes = ["RELATED", "DUPLICATE", "PARENT", "CHILD"] as const;
export const ticketEventTypes = [
  "TICKET_CREATED",
  "STATUS_CHANGED",
  "TYPE_CHANGED",
  "PRIORITY_CHANGED",
  "ACKNOWLEDGED",
  "ASSIGNMENT_CHANGED",
  "MESSAGE_RECEIVED",
  "MESSAGE_SENT",
  "INTERNAL_NOTE_ADDED",
  "SERVICE_CHANGED",
  "CATEGORY_CHANGED",
  "RESOLVED",
  "CLOSED",
  "REOPENED",
  "RELATION_ADDED",
  "MERGED",
  "NEXT_ACTION_CHANGED",
  "REPORT_ACTION",
  "LEGACY_EVENT",
  "DETAILS_CHANGED",
] as const;
export type TicketType = (typeof ticketTypes)[number];
export type TicketStatus = (typeof ticketStatuses)[number];
export type TicketResolution = (typeof ticketResolutions)[number];
export type TicketPriority = (typeof ticketPriorities)[number];
export type TicketLevel = (typeof ticketLevels)[number];
export type TicketEventType = (typeof ticketEventTypes)[number];
export type SlaState = "OK" | "AT_RISK" | "BREACHED";
export const ticketStatusLabels: Record<TicketStatus, string> = {
  NEW: "新規・未確認",
  TRIAGE: "分類中",
  ACKNOWLEDGED: "確認済み",
  IN_PROGRESS: "対応中",
  WAITING_CUSTOMER: "ユーザー待ち",
  WAITING_INTERNAL: "内部・外部サービス待ち",
  RESOLVED: "解決済み",
  CLOSED: "クローズ",
};
export const ticketTypeLabels: Record<TicketType, string> = {
  INQUIRY: "お問い合わせ",
  REPORT: "通報",
  BUG: "不具合",
  INCIDENT: "障害",
  BILLING: "課金",
  PRIVACY: "プライバシー",
  OTHER: "その他",
};
export const ticketTransitions: Record<TicketStatus, readonly TicketStatus[]> = {
  NEW: ["TRIAGE", "ACKNOWLEDGED", "RESOLVED"],
  TRIAGE: ["ACKNOWLEDGED", "RESOLVED"],
  ACKNOWLEDGED: ["IN_PROGRESS", "RESOLVED"],
  IN_PROGRESS: ["WAITING_CUSTOMER", "WAITING_INTERNAL", "RESOLVED"],
  WAITING_CUSTOMER: ["IN_PROGRESS", "RESOLVED"],
  WAITING_INTERNAL: ["IN_PROGRESS", "RESOLVED"],
  RESOLVED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: ["IN_PROGRESS"],
};
export function ticketPriority(impact: TicketLevel, urgency: TicketLevel): TicketPriority {
  const matrix: Record<TicketLevel, Record<TicketLevel, TicketPriority>> = {
    HIGH: { HIGH: "P1", MEDIUM: "P2", LOW: "P2" },
    MEDIUM: { HIGH: "P2", MEDIUM: "P3", LOW: "P3" },
    LOW: { HIGH: "P3", MEDIUM: "P3", LOW: "P4" },
  };
  return matrix[impact][urgency];
}
export interface SlaGoal {
  ack: number;
  response: number;
  resolution: number | null;
}
export const defaultSlaGoals: Record<TicketPriority, SlaGoal> = {
  P1: { ack: 15, response: 30, resolution: 240 },
  P2: { ack: 60, response: 240, resolution: 1440 },
  P3: { ack: 480, response: 1440, resolution: 4320 },
  P4: { ack: 1440, response: 2880, resolution: null },
};
export function slaClock(
  created: string,
  completed: string | null,
  minutes: number | null,
  now = Date.now(),
) {
  if (minutes === null)
    return {
      state: "OK" as SlaState,
      dueAt: null,
      elapsedMinutes: (now - Date.parse(created)) / 60000,
    };
  const dueAt = new Date(Date.parse(created) + minutes * 60000).toISOString();
  const elapsedMinutes = Math.max(
    0,
    ((completed ? Date.parse(completed) : now) - Date.parse(created)) / 60000,
  );
  const state: SlaState =
    elapsedMinutes >= minutes
      ? "BREACHED"
      : !completed && elapsedMinutes >= minutes * 0.8
        ? "AT_RISK"
        : "OK";
  return { state, dueAt, elapsedMinutes };
}
export interface Ticket {
  id: string;
  ticket_number: string;
  type: TicketType;
  status: TicketStatus;
  resolution: TicketResolution | null;
  priority: TicketPriority;
  impact: TicketLevel;
  urgency: TicketLevel;
  priority_override: string | null;
  service_id: string;
  service_name: string;
  component_id: string | null;
  category_id: string | null;
  assignment_group_id: string | null;
  assignee_id: string | null;
  subject: string;
  summary: string | null;
  requester_id: string | null;
  requester_email: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  next_action: string | null;
  next_action_at: string | null;
  revision: number;
  merged_into: string | null;
  sla_ack_minutes: number;
  sla_response_minutes: number;
  sla_resolution_minutes: number | null;
  sla_state: SlaState;
  report_id: string | null;
  thread_id: string | null;
}
export interface TicketMessage {
  id: string;
  ticket_id: string;
  direction: "INBOUND" | "OUTBOUND";
  visibility: "PUBLIC" | "INTERNAL";
  sender: string | null;
  recipient: string | null;
  subject: string | null;
  body: string;
  created_at: string;
  legacy_message_id: string | null;
  is_automatic?: number;
  attachments?: Array<{ id: string; originalFilename: string | null }>;
}
export interface TicketEvent {
  id: string;
  ticket_id: string;
  event_type: TicketEventType;
  actor_id: string | null;
  metadata: string;
  created_at: string;
}
export interface TicketRelation {
  id: string;
  source_ticket_id: string;
  target_ticket_id: string;
  relation_type: (typeof ticketRelationTypes)[number];
  ticket_number?: string;
}
export interface TicketDetail {
  ticket: Ticket;
  timeline: Array<
    { kind: "message"; value: TicketMessage } | { kind: "event"; value: TicketEvent }
  >;
  totalTimeline: number;
  relations: TicketRelation[];
}
export interface TicketPage {
  items: Ticket[];
  total: number;
}
export interface TicketMaster {
  id: string;
  name: string;
  slug?: string;
  service_id?: string;
  type?: TicketType;
  is_active: number;
}
export interface TicketMasters {
  services: TicketMaster[];
  components: TicketMaster[];
  categories: TicketMaster[];
  groups: TicketMaster[];
  assignees: TicketMaster[];
  sla: Array<SlaGoal & { priority: TicketPriority }>;
}
export interface TicketDashboard {
  open: number;
  unacknowledged: number;
  urgent: number;
  slaRisk: number;
  overdue: number;
  waitingCustomer: number;
  priorityQueue: Ticket[];
  needsAttention: Ticket[];
}
const id = z.string().min(1).max(200);
const text = z.string().trim().max(4000).nullable();
export const ticketListSchema = z.object({
  queue: z.enum(["OPEN", "UNACKNOWLEDGED", "URGENT", "SLA_RISK"]).optional(),
  status: z.enum(ticketStatuses).optional(),
  priority: z.enum(ticketPriorities).optional(),
  type: z.enum(ticketTypes).optional(),
  service_id: id.optional(),
  component_id: id.optional(),
  category_id: id.optional(),
  assignee_id: id.optional(),
  sla: z.enum(["OK", "AT_RISK", "BREACHED"]).optional(),
  query: z.string().trim().max(200).optional(),
  created_from: z.iso.datetime().optional(),
  created_to: z.iso.datetime().optional(),
  next: z.enum(["OVERDUE", "TODAY", "UPCOMING"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export type TicketListInput = z.infer<typeof ticketListSchema>;
export const createTicketSchema = z.object({
  type: z.enum(ticketTypes),
  service_id: id,
  subject: z.string().trim().min(1).max(500),
  summary: text.optional(),
  requester_email: z.email().max(320).optional(),
});
export const ticketChangeSchema = z
  .object({
    id,
    revision: z.number().int().min(0),
    status: z.enum(ticketStatuses).optional(),
    resolution: z.enum(ticketResolutions).nullable().optional(),
    type: z.enum(ticketTypes).optional(),
    impact: z.enum(ticketLevels).optional(),
    urgency: z.enum(ticketLevels).optional(),
    priority: z.enum(ticketPriorities).optional(),
    override_reason: z.string().trim().min(1).max(2000).nullable().optional(),
    service_id: id.optional(),
    component_id: id.nullable().optional(),
    category_id: id.nullable().optional(),
    assignment_group_id: id.nullable().optional(),
    assignee_id: id.nullable().optional(),
    subject: z.string().trim().min(1).max(500).optional(),
    summary: text.optional(),
    next_action: text.optional(),
    next_action_at: z.iso.datetime().nullable().optional(),
  })
  .strict();
export const ticketNoteSchema = z
  .object({ id, body: z.string().trim().min(1).max(100000), idempotencyKey: id })
  .strict();
export const ticketRelationSchema = z
  .object({ id, target_id: id, relation_type: z.enum(ticketRelationTypes) })
  .strict();
export const ticketMergeSchema = z
  .object({
    id,
    target_id: id,
    revision: z.number().int().min(0),
    target_revision: z.number().int().min(0),
  })
  .strict();
