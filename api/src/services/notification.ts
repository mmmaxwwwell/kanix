// ---------------------------------------------------------------------------
// Notification Service — stub for order confirmation emails
// ---------------------------------------------------------------------------

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

export function createNotificationService(): NotificationService {
  const sent: NotificationRecord[] = [];

  return {
    sendOrderConfirmation(orderId: string, email: string, orderNumber: string): void {
      sent.push({
        type: "order_confirmation",
        orderId,
        email,
        message: `Order confirmation for ${orderNumber} sent to ${email}`,
        timestamp: new Date(),
      });
    },

    getSent(): NotificationRecord[] {
      return [...sent];
    },

    clear(): void {
      sent.length = 0;
    },
  };
}
