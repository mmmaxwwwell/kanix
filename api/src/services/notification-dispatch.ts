import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { WsManager } from "../ws/manager.js";

// ---------------------------------------------------------------------------
// Email adapter interface + stub implementation
// ---------------------------------------------------------------------------

export interface EmailAdapter {
  send(to: string, subject: string, body: string, templateId: string): void;
}

export function createEmailStubAdapter(logPath?: string): EmailAdapter {
  const filePath = logPath ?? join(process.cwd(), "logs", "emails.jsonl");

  return {
    send(to: string, subject: string, body: string, templateId: string): void {
      mkdirSync(dirname(filePath), { recursive: true });
      const entry = {
        to,
        subject,
        body,
        templateId,
        timestamp: new Date().toISOString(),
      };
      appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    },
  };
}

// ---------------------------------------------------------------------------
// Push adapter interface + stub implementation
// ---------------------------------------------------------------------------

export interface PushAdapter {
  send(userId: string, title: string, body: string, data?: Record<string, unknown>): void;
}

export function createPushStubAdapter(): PushAdapter {
  const sent: Array<{
    userId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }> = [];

  return {
    send(userId: string, title: string, body: string, data?: Record<string, unknown>): void {
      sent.push({ userId, title, body, data });
    },
  };
}

// ---------------------------------------------------------------------------
// In-app adapter (via WebSocket)
// ---------------------------------------------------------------------------

export interface InAppAdapter {
  send(entity: string, entityId: string, type: string, data: Record<string, unknown>): void;
}

export function createInAppAdapter(wsManager: WsManager | undefined): InAppAdapter {
  return {
    send(entity: string, entityId: string, type: string, data: Record<string, unknown>): void {
      if (!wsManager) return;
      wsManager.publish(entity, entityId, type, data);
    },
  };
}

// ---------------------------------------------------------------------------
// Alert preference type
// ---------------------------------------------------------------------------

export type AlertChannel = "email" | "push" | "both";

export interface AdminAlertTarget {
  adminUserId: string;
  email: string;
  channel: AlertChannel;
}

// ---------------------------------------------------------------------------
// Notification dispatch service
// ---------------------------------------------------------------------------

export interface NotificationDispatchService {
  emailAdapter: EmailAdapter;
  pushAdapter: PushAdapter;
  inAppAdapter: InAppAdapter;

  /**
   * Dispatch an alert to a list of admin targets based on their channel preferences.
   * - "email" → email adapter only
   * - "push" → in-app (WebSocket) adapter only
   * - "both" → email + in-app
   */
  dispatchAlert(
    targets: AdminAlertTarget[],
    alert: {
      subject: string;
      body: string;
      templateId: string;
      entity: string;
      entityId: string;
      eventType: string;
      data: Record<string, unknown>;
    },
  ): void;
}

export function createNotificationDispatchService(opts: {
  emailAdapter?: EmailAdapter;
  pushAdapter?: PushAdapter;
  wsManager?: WsManager;
  emailLogPath?: string;
}): NotificationDispatchService {
  const emailAdapter = opts.emailAdapter ?? createEmailStubAdapter(opts.emailLogPath);
  const pushAdapter = opts.pushAdapter ?? createPushStubAdapter();
  const inAppAdapter = createInAppAdapter(opts.wsManager);

  return {
    emailAdapter,
    pushAdapter,
    inAppAdapter,

    dispatchAlert(targets, alert) {
      for (const target of targets) {
        if (target.channel === "email" || target.channel === "both") {
          emailAdapter.send(target.email, alert.subject, alert.body, alert.templateId);
        }
        if (target.channel === "push" || target.channel === "both") {
          inAppAdapter.send(alert.entity, alert.entityId, alert.eventType, alert.data);
        }
      }
    },
  };
}
