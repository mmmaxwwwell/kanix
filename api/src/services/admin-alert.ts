// ---------------------------------------------------------------------------
// Admin Alert Service — in-memory queue for admin notifications
// ---------------------------------------------------------------------------

export interface AdminAlert {
  type: string;
  orderId: string;
  message: string;
  details: Record<string, unknown>;
  timestamp: Date;
}

export interface AdminAlertService {
  /** Queue an alert for admin review. */
  queue(alert: Omit<AdminAlert, "timestamp">): void;

  /** Return all queued alerts (useful for testing and future consumers). */
  getAlerts(): AdminAlert[];

  /** Clear all queued alerts. */
  clear(): void;
}

export function createAdminAlertService(): AdminAlertService {
  const alerts: AdminAlert[] = [];

  return {
    queue(alert: Omit<AdminAlert, "timestamp">): void {
      alerts.push({ ...alert, timestamp: new Date() });
    },

    getAlerts(): AdminAlert[] {
      return [...alerts];
    },

    clear(): void {
      alerts.length = 0;
    },
  };
}
