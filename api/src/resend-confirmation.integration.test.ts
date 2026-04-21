import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine } from "./db/schema/order.js";
import { eq } from "drizzle-orm";
import {
  resendOrderConfirmation,
  clearResendRateLimits,
} from "./db/queries/order-resend-confirmation.js";
import { createNotificationService } from "./services/notification.js";
import { requireDatabaseUrl } from "./test-helpers.js";

const DATABASE_URL = requireDatabaseUrl();

describe("resend-confirmation integration (T059d)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  let testOrderId = "";

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create a test order (confirmed, paid)
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T059d-${ts}`,
        email: `t059d-${ts}@test.kanix.dev`,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 5000,
        taxMinor: 250,
        shippingMinor: 599,
        totalMinor: 5849,
        placedAt: new Date(),
      })
      .returning();
    testOrderId = newOrder.id;
  });

  beforeEach(() => {
    clearResendRateLimits();
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      await db.delete(orderLine).where(eq(orderLine.orderId, testOrderId));
      await db.delete(order).where(eq(order.id, testOrderId));
      await dbConn.close();
    }
  });

  it("resends order confirmation and logs to notification service", async () => {
    const db = dbConn.db;
    const notificationService = createNotificationService();

    const result = await resendOrderConfirmation(db, testOrderId, notificationService);

    expect(result.success).toBe(true);
    expect(result.orderId).toBe(testOrderId);
    expect(result.email).toBe(`t059d-${ts}@test.kanix.dev`);

    // Verify notification was logged
    const sent = notificationService.getSent();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("order_confirmation");
    expect(sent[0].orderId).toBe(testOrderId);
    expect(sent[0].email).toBe(`t059d-${ts}@test.kanix.dev`);
    expect(sent[0].message).toContain(`KNX-T059d-${ts}`);
  });

  it("rate-limits rapid resend (max 1 per 5 minutes per order)", async () => {
    const db = dbConn.db;
    const notificationService = createNotificationService();

    // First resend should succeed
    const result1 = await resendOrderConfirmation(db, testOrderId, notificationService);
    expect(result1.success).toBe(true);

    // Second resend within 5 minutes should be rate-limited
    await expect(
      resendOrderConfirmation(db, testOrderId, notificationService),
    ).rejects.toMatchObject({
      code: "ERR_RATE_LIMIT_EXCEEDED",
    });

    // Only one notification should have been sent
    const sent = notificationService.getSent();
    expect(sent).toHaveLength(1);
  });

  it("rejects resend for non-existent order", async () => {
    const db = dbConn.db;
    const notificationService = createNotificationService();

    await expect(
      resendOrderConfirmation(db, "00000000-0000-0000-0000-000000000099", notificationService),
    ).rejects.toMatchObject({
      code: "ERR_ORDER_NOT_FOUND",
    });
  });

  it("allows resend after rate limit window expires", async () => {
    const db = dbConn.db;
    const notificationService = createNotificationService();

    // First resend
    await resendOrderConfirmation(db, testOrderId, notificationService);

    // Clear rate limits to simulate window expiry
    clearResendRateLimits();

    // Should succeed again
    const result2 = await resendOrderConfirmation(db, testOrderId, notificationService);
    expect(result2.success).toBe(true);

    const sent = notificationService.getSent();
    expect(sent).toHaveLength(2);
  });
});
