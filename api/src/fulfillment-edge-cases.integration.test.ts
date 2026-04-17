import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderLine, orderStatusHistory } from "./db/schema/order.js";
import { fulfillmentTask } from "./db/schema/fulfillment.js";
import { product, productVariant } from "./db/schema/catalog.js";
import {
  inventoryBalance,
  inventoryAdjustment,
  inventoryMovement,
  inventoryLocation,
} from "./db/schema/inventory.js";
import { adminUser } from "./db/schema/admin.js";
import { eq } from "drizzle-orm";
import {
  createFulfillmentTask,
  transitionFulfillmentTaskStatus,
  assignFulfillmentTask,
  findFulfillmentTaskById,
  blockFulfillmentTask,
  unblockFulfillmentTask,
  cancelFulfillmentTask,
} from "./db/queries/fulfillment-task.js";
import { createInventoryAdjustment } from "./db/queries/inventory.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const canRun = DATABASE_URL !== undefined;
const describeWithDeps = canRun ? describe : describe.skip;

describeWithDeps("fulfillment edge cases (T066c)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdOrderIds: string[] = [];
  const createdTaskIds: string[] = [];
  let testProductId: string;
  let testVariantId: string;
  let testLocationId: string;
  let testAdminUserId: string;

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL ?? "");
    const db = dbConn.db;

    // Create test admin user (needed for FK constraints)
    const [admin] = await db
      .insert(adminUser)
      .values({
        authSubject: `t066c-admin-${ts}`,
        email: `t066c-admin-${ts}@test.kanix.dev`,
        name: "T066c Test Admin",
        status: "active",
      })
      .returning();
    testAdminUserId = admin.id;

    // Create test product and variant
    const [prod] = await db
      .insert(product)
      .values({
        slug: `t066c-product-${ts}`,
        title: `T066c Test Product ${ts}`,
        status: "active",
      })
      .returning();
    testProductId = prod.id;

    const [variant] = await db
      .insert(productVariant)
      .values({
        productId: testProductId,
        sku: `T066C-SKU-${ts}`,
        title: `T066c Variant ${ts}`,
        priceMinor: 2500,
        status: "active",
      })
      .returning();
    testVariantId = variant.id;

    // Create test inventory location
    const [loc] = await db
      .insert(inventoryLocation)
      .values({
        name: `T066c Warehouse ${ts}`,
        code: `T066C-WH-${ts}`,
        type: "warehouse",
      })
      .returning();
    testLocationId = loc.id;

    // Seed initial inventory balance (restock 100 units)
    await createInventoryAdjustment(db, {
      variantId: testVariantId,
      locationId: testLocationId,
      adjustmentType: "restock",
      quantityDelta: 100,
      reason: "Initial seed for T066c tests",
      actorAdminUserId: testAdminUserId,
    });
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Clean up in reverse order of dependencies
      for (const taskId of createdTaskIds) {
        await db.delete(fulfillmentTask).where(eq(fulfillmentTask.id, taskId));
      }
      // Clean up inventory data before orders (adjustments reference orders via FK)
      await db.delete(inventoryMovement).where(eq(inventoryMovement.locationId, testLocationId));
      await db
        .delete(inventoryAdjustment)
        .where(eq(inventoryAdjustment.locationId, testLocationId));
      await db.delete(inventoryBalance).where(eq(inventoryBalance.locationId, testLocationId));
      // Now clean up orders
      for (const orderId of createdOrderIds) {
        await db.delete(orderLine).where(eq(orderLine.orderId, orderId));
        await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId));
        await db.delete(order).where(eq(order.id, orderId));
      }
      await db.delete(inventoryLocation).where(eq(inventoryLocation.id, testLocationId));
      await db.delete(productVariant).where(eq(productVariant.id, testVariantId));
      await db.delete(product).where(eq(product.id, testProductId));
      await db.delete(adminUser).where(eq(adminUser.id, testAdminUserId));
      await dbConn.close();
    }
  });

  // Helper to create a test order with order lines
  async function createTestOrder(suffix: string, qty = 3) {
    const db = dbConn.db;
    const [newOrder] = await db
      .insert(order)
      .values({
        orderNumber: `KNX-T066C-${suffix}`,
        email: `t066c-${suffix}@test.kanix.dev`,
        status: "confirmed",
        paymentStatus: "paid",
        fulfillmentStatus: "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 2500 * qty,
        taxMinor: 0,
        shippingMinor: 599,
        totalMinor: 2500 * qty + 599,
        placedAt: new Date(),
      })
      .returning();
    createdOrderIds.push(newOrder.id);

    // Add order line
    await db.insert(orderLine).values({
      orderId: newOrder.id,
      variantId: testVariantId,
      skuSnapshot: `T066C-SKU-${ts}`,
      titleSnapshot: `T066c Variant ${ts}`,
      quantity: qty,
      unitPriceMinor: 2500,
      totalMinor: 2500 * qty,
    });

    return newOrder;
  }

  // Helper to walk task to a target status
  async function walkTaskTo(taskId: string, target: string) {
    const db = dbConn.db;
    const steps = ["assigned", "picking", "picked", "packing", "packed", "shipment_pending"];
    await assignFulfillmentTask(db, taskId, testAdminUserId);
    for (const step of steps) {
      if (step === target) break;
      if (step === "assigned") continue; // already done via assign
      await transitionFulfillmentTaskStatus(db, { taskId, newStatus: step });
    }
    if (target !== "assigned") {
      await transitionFulfillmentTaskStatus(db, { taskId, newStatus: target });
    }
  }

  // -------------------------------------------------------------------------
  // Blocked transition requires reason
  // -------------------------------------------------------------------------

  it("rejects blocked transition without reason", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-no-reason`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await expect(
      transitionFulfillmentTaskStatus(db, {
        taskId: task.id,
        newStatus: "blocked",
        // no reason
      }),
    ).rejects.toMatchObject({ code: "ERR_REASON_REQUIRED" });
  });

  it("accepts blocked transition with reason", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-with-reason`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    const result = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "blocked",
      reason: "Missing inventory",
    });
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("Missing inventory");
    expect(result.preBlockedStatus).toBe("new");
  });

  // -------------------------------------------------------------------------
  // Blocked from any active state, stores pre-blocked status
  // -------------------------------------------------------------------------

  it("stores preBlockedStatus when blocking from picking", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-blocked-picking`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await walkTaskTo(task.id, "picking");

    const blocked = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "blocked",
      reason: "missing_inventory",
    });
    expect(blocked.preBlockedStatus).toBe("picking");

    // Verify persisted
    const found = await findFulfillmentTaskById(db, task.id);
    expect(found?.blockedReason).toBe("missing_inventory");
    expect(found?.preBlockedStatus).toBe("picking");
  });

  // -------------------------------------------------------------------------
  // Unblock transitions back to previous active state
  // -------------------------------------------------------------------------

  it("unblocks task back to pre-blocked status", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-unblock`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await walkTaskTo(task.id, "picking");

    // Block
    await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "blocked",
      reason: "missing_inventory",
    });

    // Unblock
    const result = await unblockFulfillmentTask(db, task.id);
    expect(result.status).toBe("picking");
    expect(result.oldStatus).toBe("blocked");
    expect(result.blockedReason).toBeNull();
    expect(result.preBlockedStatus).toBeNull();
  });

  it("rejects unblock on non-blocked task", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-unblock-err`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await expect(unblockFulfillmentTask(db, task.id)).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  // -------------------------------------------------------------------------
  // Block during picking with inventory adjustment
  // -------------------------------------------------------------------------

  it("blocks task during picking and triggers inventory adjustment", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-block-adj`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await walkTaskTo(task.id, "picking");

    const result = await blockFulfillmentTask(db, {
      taskId: task.id,
      reason: "missing_inventory",
      actorAdminUserId: testAdminUserId,
      inventoryAdjustment: {
        variantId: testVariantId,
        locationId: testLocationId,
        adjustmentType: "shrinkage",
        quantityDelta: -2,
      },
    });

    // Task is blocked
    expect(result.task.status).toBe("blocked");
    expect(result.task.preBlockedStatus).toBe("picking");
    expect(result.task.blockedReason).toBe("missing_inventory");

    // Inventory adjustment was created
    const adjResult = result.inventoryAdjustmentResult;
    expect(adjResult).toBeDefined();
    expect(adjResult?.adjustment.quantityDelta).toBe(-2);
    expect(adjResult?.adjustment.adjustmentType).toBe("shrinkage");
    expect(adjResult?.adjustment.relatedOrderId).toBe(testOrder.id);

    // Can unblock back to picking after resolution
    const unblocked = await unblockFulfillmentTask(db, task.id);
    expect(unblocked.status).toBe("picking");
  });

  // -------------------------------------------------------------------------
  // Cancel after picking auto-creates inventory adjustments
  // -------------------------------------------------------------------------

  it("cancel after picking auto-creates inventory return adjustments", async () => {
    const db = dbConn.db;
    const qty = 5;
    const testOrder = await createTestOrder(`${ts}-cancel-picked`, qty);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Walk to picked state
    await walkTaskTo(task.id, "picked");

    // Get balance before cancel
    const [balanceBefore] = await db
      .select()
      .from(inventoryBalance)
      .where(eq(inventoryBalance.locationId, testLocationId));

    const result = await cancelFulfillmentTask(db, {
      taskId: task.id,
      reason: "Customer requested cancellation",
      actorAdminUserId: testAdminUserId,
      locationId: testLocationId,
    });

    // Task is canceled
    expect(result.task.newStatus).toBe("canceled");
    expect(result.task.oldStatus).toBe("picked");

    // Inventory adjustments were created to return picked items
    expect(result.inventoryAdjustments.length).toBe(1);
    expect(result.inventoryAdjustments[0].adjustment.adjustmentType).toBe("return");
    expect(result.inventoryAdjustments[0].adjustment.quantityDelta).toBe(qty);

    // Balance increased by the returned quantity
    const [balanceAfter] = await db
      .select()
      .from(inventoryBalance)
      .where(eq(inventoryBalance.locationId, testLocationId));
    expect(balanceAfter.available).toBe(balanceBefore.available + qty);
  });

  it("cancel before picking does NOT create inventory adjustments", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-cancel-new`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Cancel from new state (before any picking)
    const result = await cancelFulfillmentTask(db, {
      taskId: task.id,
      reason: "Order canceled before picking",
      actorAdminUserId: testAdminUserId,
      locationId: testLocationId,
    });

    expect(result.task.newStatus).toBe("canceled");
    // No inventory adjustments since items were never picked
    expect(result.inventoryAdjustments.length).toBe(0);
  });

  it("cancel from picking state does NOT auto-adjust (only post-picking)", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-cancel-picking`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await walkTaskTo(task.id, "picking");

    const result = await cancelFulfillmentTask(db, {
      taskId: task.id,
      reason: "Canceled during picking",
      actorAdminUserId: testAdminUserId,
      locationId: testLocationId,
    });

    expect(result.task.newStatus).toBe("canceled");
    // picking state is not post-picking, items not fully picked yet
    expect(result.inventoryAdjustments.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Full scenario: picking → blocked (missing_inventory) → adjustment → unblock → picking
  // -------------------------------------------------------------------------

  it("full scenario: picking → blocked → adjustment → unblock → picking", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder(`${ts}-full-scenario`);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Walk to picking
    await walkTaskTo(task.id, "picking");
    let found = await findFulfillmentTaskById(db, task.id);
    expect(found?.status).toBe("picking");

    // Block due to inventory discrepancy
    const blockResult = await blockFulfillmentTask(db, {
      taskId: task.id,
      reason: "missing_inventory",
      actorAdminUserId: testAdminUserId,
      inventoryAdjustment: {
        variantId: testVariantId,
        locationId: testLocationId,
        adjustmentType: "correction",
        quantityDelta: -1,
      },
    });

    expect(blockResult.task.status).toBe("blocked");
    expect(blockResult.inventoryAdjustmentResult).toBeDefined();

    // Verify task is blocked in DB
    found = await findFulfillmentTaskById(db, task.id);
    expect(found?.status).toBe("blocked");
    expect(found?.blockedReason).toBe("missing_inventory");
    expect(found?.preBlockedStatus).toBe("picking");

    // Unblock after issue resolved
    const unblockResult = await unblockFulfillmentTask(db, task.id);
    expect(unblockResult.status).toBe("picking");

    // Verify task is back to picking in DB
    found = await findFulfillmentTaskById(db, task.id);
    expect(found?.status).toBe("picking");
    expect(found?.blockedReason).toBeNull();
    expect(found?.preBlockedStatus).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Cancel after picking from blocked state → verify auto-adjustment
  // -------------------------------------------------------------------------

  it("cancel from blocked state (previously picked) auto-adjusts inventory", async () => {
    const db = dbConn.db;
    const qty = 2;
    const testOrder = await createTestOrder(`${ts}-cancel-blocked`, qty);
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Walk to packed, then block
    await walkTaskTo(task.id, "packed");
    await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "blocked",
      reason: "QA hold",
    });

    // Cancel from blocked (was packed, which is post-picking)
    const result = await cancelFulfillmentTask(db, {
      taskId: task.id,
      reason: "QA failed, cancel order",
      actorAdminUserId: testAdminUserId,
      locationId: testLocationId,
    });

    expect(result.task.newStatus).toBe("canceled");
    // Should auto-adjust because the task was post-picking before being blocked
    expect(result.inventoryAdjustments.length).toBe(1);
    expect(result.inventoryAdjustments[0].adjustment.quantityDelta).toBe(qty);
  });
});
