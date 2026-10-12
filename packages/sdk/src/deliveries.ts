/** Safe delivery status: never contains a mail body, address, attachment or provider response. */
export interface OperatorDeliveryJob {
  id: string;
  projectId: string;
  projectName?: string;
  kind: "notification_email" | "notification_push" | "inbound_email" | "failure_alert";
  state: "queued" | "running" | "failed" | "completed";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface OperatorDeliveryPage {
  items: OperatorDeliveryJob[];
  total: number;
}
