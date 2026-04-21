// ---------------------------------------------------------------------------
// Notification Service — stub for order confirmation emails
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface NotificationRecord {
  type: string;
  orderId: string;
  email: string;
  message: string;
  timestamp: Date;
}

export interface NotificationService {
  /** Send an order confirmation notification (stub: logs to in-memory queue). */
  sendOrderConfirmation(orderId: string, email: string, orderNumber: string): void;

  /** Return all sent notifications (useful for testing). */
  getSent(): NotificationRecord[];

  /** Clear all sent notifications. */
  clear(): void;
}

export function createNotificationService(opts?: { emailLogPath?: string }): NotificationService {
  const sent: NotificationRecord[] = [];
  const emailLogPath = opts?.emailLogPath ?? join(process.cwd(), "logs", "emails.jsonl");

  return {
    sendOrderConfirmation(orderId: string, email: string, orderNumber: string): void {
      const record: NotificationRecord = {
        type: "order_confirmation",
        orderId,
        email,
        message: `Order confirmation for ${orderNumber} sent to ${email}`,
        timestamp: new Date(),
      };
      sent.push(record);

      // Also log to JSONL file for integration test verification
      mkdirSync(dirname(emailLogPath), { recursive: true });
      appendFileSync(
        emailLogPath,
        JSON.stringify({
          to: email,
          subject: `Order Confirmation: ${orderNumber}`,
          body: record.message,
          templateId: "order_confirmation",
          orderId,
          orderNumber,
          timestamp: record.timestamp.toISOString(),
        }) + "\n",
        "utf-8",
      );
    },

    getSent(): NotificationRecord[] {
      return [...sent];
    },

    clear(): void {
      sent.length = 0;
    },
  };
}
