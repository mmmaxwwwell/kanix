import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { order } from "../schema/order.js";
import type { NotificationService } from "../../services/notification.js";

// ---------------------------------------------------------------------------
// Per-order rate limiter (in-memory, max 1 per 5 minutes)
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const lastSentMap = new Map<string, number>();

export function canResendConfirmation(orderId: string, nowMs?: number): boolean {
  const now = nowMs ?? Date.now();
  const lastSent = lastSentMap.get(orderId);
  if (lastSent === undefined) return true;
  return now - lastSent >= RATE_LIMIT_WINDOW_MS;
}

export function recordResend(orderId: string, nowMs?: number): void {
  lastSentMap.set(orderId, nowMs ?? Date.now());
}

/** Clear rate-limit state (for testing). */
export function clearResendRateLimits(): void {
  lastSentMap.clear();
}

// ---------------------------------------------------------------------------
// Resend order confirmation
// ---------------------------------------------------------------------------

export async function resendOrderConfirmation(
  db: PostgresJsDatabase,
  orderId: string,
  notificationService: NotificationService,
): Promise<{ success: true; orderId: string; email: string }> {
  // Find the order
  const [found] = await db
    .select({
      id: order.id,
      orderNumber: order.orderNumber,
      email: order.email,
      status: order.status,
    })
    .from(order)
    .where(eq(order.id, orderId));

  if (!found) {
    const err = new Error("Order not found");
    (err as Error & { code: string }).code = "ERR_ORDER_NOT_FOUND";
    throw err;
  }

  // Rate-limit check
  if (!canResendConfirmation(orderId)) {
    const err = new Error(
      "Rate limit exceeded: confirmation can only be resent once every 5 minutes",
    );
    (err as Error & { code: string }).code = "ERR_RATE_LIMIT_EXCEEDED";
    throw err;
  }

  // Queue the notification
  notificationService.sendOrderConfirmation(found.id, found.email, found.orderNumber);

  // Record the send time for rate limiting
  recordResend(orderId);

  return { success: true, orderId: found.id, email: found.email };
}
