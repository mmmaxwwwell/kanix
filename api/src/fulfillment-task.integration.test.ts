import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderStatusHistory } from "./db/schema/order.js";
import { fulfillmentTask } from "./db/schema/fulfillment.js";
import { eq } from "drizzle-orm";
import { requireDatabaseUrl } from "./test-helpers.js";
import {
  createFulfillmentTask,
  createFulfillmentTaskForPaidOrder,
  transitionFulfillmentTaskStatus,
  assignFulfillmentTask,
  findFulfillmentTaskById,
  findFulfillmentTasksByOrderId,
  listFulfillmentTasks,
  isValidFulfillmentTaskTransition,
  calculateFulfillmentPriority,
} from "./db/queries/fulfillment-task.js";

const DATABASE_URL = requireDatabaseUrl();

describe("fulfillment task integration (T056)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdOrderIds: string[] = [];
  const createdTaskIds: string[] = [];

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Clean up in reverse order of dependencies
      for (const taskId of createdTaskIds) {
        await db.delete(fulfillmentTask).where(eq(fulfillmentTask.id, taskId));
      }
      for (const orderId of createdOrderIds) {
        await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId));
        await db.delete(order).where(eq(order.id, orderId));
      }
      await dbConn.close();
    }
  });

  // Helper to create a test order
  async function createTestOrder(overrides: {
    status?: string;
    paymentStatus?: string;
    fulfillmentStatus?: string;
    placedAt?: Date;
    suffix?: string;
  }) {
    const suffix = overrides.suffix ?? `${ts}-${createdOrderIds.length}`;
    const [newOrder] = await dbConn.db
      .insert(order)
      .values({
        orderNumber: `KNX-T056-${suffix}`,
        email: `t056-${suffix}@test.kanix.dev`,
        status: overrides.status ?? "confirmed",
        paymentStatus: overrides.paymentStatus ?? "paid",
        fulfillmentStatus: overrides.fulfillmentStatus ?? "unfulfilled",
        shippingStatus: "not_shipped",
        subtotalMinor: 5000,
        taxMinor: 0,
        shippingMinor: 599,
        totalMinor: 5599,
        placedAt: overrides.placedAt ?? new Date(),
      })
      .returning();
    createdOrderIds.push(newOrder.id);
    return newOrder;
  }

  // -------------------------------------------------------------------------
  // Unit-level: state machine validation
  // -------------------------------------------------------------------------

  it("validates correct transitions", () => {
    expect(isValidFulfillmentTaskTransition("new", "assigned")).toBe(true);
    expect(isValidFulfillmentTaskTransition("assigned", "picking")).toBe(true);
    expect(isValidFulfillmentTaskTransition("picking", "picked")).toBe(true);
    expect(isValidFulfillmentTaskTransition("picked", "packing")).toBe(true);
    expect(isValidFulfillmentTaskTransition("packing", "packed")).toBe(true);
    expect(isValidFulfillmentTaskTransition("packed", "shipment_pending")).toBe(true);
    expect(isValidFulfillmentTaskTransition("shipment_pending", "done")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(isValidFulfillmentTaskTransition("new", "picking")).toBe(false);
    expect(isValidFulfillmentTaskTransition("done", "new")).toBe(false);
    expect(isValidFulfillmentTaskTransition("canceled", "new")).toBe(false);
    expect(isValidFulfillmentTaskTransition("new", "done")).toBe(false);
  });

  it("allows blocked transition from any active state", () => {
    expect(isValidFulfillmentTaskTransition("new", "blocked")).toBe(true);
    expect(isValidFulfillmentTaskTransition("assigned", "blocked")).toBe(true);
    expect(isValidFulfillmentTaskTransition("picking", "blocked")).toBe(true);
    expect(isValidFulfillmentTaskTransition("shipment_pending", "blocked")).toBe(true);
  });

  it("allows canceled transition from pre-shipment states", () => {
    expect(isValidFulfillmentTaskTransition("new", "canceled")).toBe(true);
    expect(isValidFulfillmentTaskTransition("assigned", "canceled")).toBe(true);
    expect(isValidFulfillmentTaskTransition("picking", "canceled")).toBe(true);
    // shipment_pending should NOT allow canceled
    expect(isValidFulfillmentTaskTransition("shipment_pending", "canceled")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // SLA priority calculation
  // -------------------------------------------------------------------------

  it("order before cutoff → high priority with sla_at_risk", () => {
    // 10:00 AM — before 2:00 PM cutoff
    const morning = new Date();
    morning.setHours(10, 0, 0, 0);
    const result = calculateFulfillmentPriority(morning);
    expect(result.priority).toBe("high");
    expect(result.slaAtRisk).toBe(true);
  });

  it("order after cutoff → normal priority", () => {
    // 3:00 PM — after 2:00 PM cutoff
    const afternoon = new Date();
    afternoon.setHours(15, 0, 0, 0);
    const result = calculateFulfillmentPriority(afternoon);
    expect(result.priority).toBe("normal");
    expect(result.slaAtRisk).toBe(false);
  });

  it("order at midnight → high priority (before cutoff)", () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const result = calculateFulfillmentPriority(midnight);
    expect(result.priority).toBe("high");
    expect(result.slaAtRisk).toBe(true);
  });

  it("supports configurable cutoff hour", () => {
    const tenAM = new Date();
    tenAM.setHours(10, 0, 0, 0);
    // With cutoff at 9 AM, 10 AM is AFTER cutoff
    const result = calculateFulfillmentPriority(tenAM, 9);
    expect(result.priority).toBe("normal");
    expect(result.slaAtRisk).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Payment succeeds → task created
  // -------------------------------------------------------------------------

  it("auto-creates fulfillment task when order payment_status is paid", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({
      status: "confirmed",
      paymentStatus: "paid",
      fulfillmentStatus: "unfulfilled",
    });

    const result = await createFulfillmentTaskForPaidOrder(db, testOrder.id);
    createdTaskIds.push(result.id);

    expect(result.orderId).toBe(testOrder.id);
    expect(result.status).toBe("new");
    expect(["normal", "high"]).toContain(result.priority);
  });

  it("rejects fulfillment task creation when payment_status is not paid", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({
      status: "pending_payment",
      paymentStatus: "unpaid",
    });

    await expect(createFulfillmentTaskForPaidOrder(db, testOrder.id)).rejects.toMatchObject({
      code: "ERR_PAYMENT_NOT_PAID",
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle: walk task through all states
  // -------------------------------------------------------------------------

  it("walks fulfillment task through full lifecycle: new → assigned → ... → done", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({});

    // Create task
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    expect(task.status).toBe("new");

    // new → assigned (via assign)
    const assigned = await assignFulfillmentTask(
      db,
      task.id,
      "00000000-0000-0000-0000-000000000001",
    );
    expect(assigned.status).toBe("assigned");
    expect(assigned.assignedAdminUserId).toBe("00000000-0000-0000-0000-000000000001");

    // assigned → picking
    const picking = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "picking",
    });
    expect(picking.status).toBe("picking");
    expect(picking.oldStatus).toBe("assigned");

    // picking → picked
    const picked = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "picked",
    });
    expect(picked.status).toBe("picked");

    // picked → packing
    const packing = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "packing",
    });
    expect(packing.status).toBe("packing");

    // packing → packed
    const packed = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "packed",
    });
    expect(packed.status).toBe("packed");

    // packed → shipment_pending
    const shipmentPending = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "shipment_pending",
    });
    expect(shipmentPending.status).toBe("shipment_pending");

    // shipment_pending → done
    const done = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "done",
    });
    expect(done.status).toBe("done");

    // Verify final state
    const finalTask = await findFulfillmentTaskById(db, task.id);
    expect(finalTask).not.toBeNull();
    expect(finalTask?.status).toBe("done");
  });

  // -------------------------------------------------------------------------
  // Invalid transitions rejected
  // -------------------------------------------------------------------------

  it("rejects invalid transition: new → done", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-invalid` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await expect(
      transitionFulfillmentTaskStatus(db, {
        taskId: task.id,
        newStatus: "done",
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  it("rejects transition from done state", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-done` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Walk to done quickly
    await assignFulfillmentTask(db, task.id, "00000000-0000-0000-0000-000000000001");
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picking" });
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picked" });
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "packing" });
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "packed" });
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "shipment_pending" });
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "done" });

    await expect(
      transitionFulfillmentTaskStatus(db, {
        taskId: task.id,
        newStatus: "new",
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  // -------------------------------------------------------------------------
  // Blocked state
  // -------------------------------------------------------------------------

  it("transitions to blocked from active state, then recovers", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-blocked` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Assign and start picking
    await assignFulfillmentTask(db, task.id, "00000000-0000-0000-0000-000000000001");
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picking" });

    // Block the task (e.g., inventory issue)
    const blocked = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "blocked",
      reason: "Out of stock on item",
    });
    expect(blocked.status).toBe("blocked");

    // Recover — blocked can go back to picking
    const recovered = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "picking",
    });
    expect(recovered.status).toBe("picking");
  });

  // -------------------------------------------------------------------------
  // Assignment API
  // -------------------------------------------------------------------------

  it("assigns a task and transitions new → assigned", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-assign1` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    expect(task.status).toBe("new");

    const result = await assignFulfillmentTask(db, task.id, "00000000-0000-0000-0000-000000000002");
    expect(result.status).toBe("assigned");
    expect(result.assignedAdminUserId).toBe("00000000-0000-0000-0000-000000000002");
  });

  it("re-assigns an already assigned task without changing status", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-reassign` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await assignFulfillmentTask(db, task.id, "00000000-0000-0000-0000-000000000001");
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picking" });

    // Re-assign to different admin while in picking status
    const result = await assignFulfillmentTask(db, task.id, "00000000-0000-0000-0000-000000000002");
    expect(result.status).toBe("picking"); // status unchanged
    expect(result.assignedAdminUserId).toBe("00000000-0000-0000-0000-000000000002");
  });

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  it("finds fulfillment tasks by order ID", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-find` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    const tasks = await findFulfillmentTasksByOrderId(db, testOrder.id);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.some((t) => t.id === task.id)).toBe(true);
  });

  it("lists fulfillment tasks with status filter", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-list` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    const newTasks = await listFulfillmentTasks(db, { status: "new" });
    expect(newTasks.some((t) => t.id === task.id)).toBe(true);

    const doneTasks = await listFulfillmentTasks(db, { status: "done" });
    expect(doneTasks.some((t) => t.id === task.id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // SLA priority: order before cutoff → high, after → normal
  // -------------------------------------------------------------------------

  it("order before cutoff gets high priority fulfillment task", async () => {
    const db = dbConn.db;
    const morning = new Date();
    morning.setHours(9, 0, 0, 0); // 9 AM — before 2 PM cutoff

    const testOrder = await createTestOrder({
      suffix: `${ts}-sla-high`,
      placedAt: morning,
    });

    const result = await createFulfillmentTaskForPaidOrder(db, testOrder.id);
    createdTaskIds.push(result.id);

    expect(result.priority).toBe("high");
    expect(result.slaAtRisk).toBe(true);
  });

  it("order after cutoff gets normal priority fulfillment task", async () => {
    const db = dbConn.db;
    const afternoon = new Date();
    afternoon.setHours(16, 0, 0, 0); // 4 PM — after 2 PM cutoff

    const testOrder = await createTestOrder({
      suffix: `${ts}-sla-normal`,
      placedAt: afternoon,
    });

    const result = await createFulfillmentTaskForPaidOrder(db, testOrder.id);
    createdTaskIds.push(result.id);

    expect(result.priority).toBe("normal");
    expect(result.slaAtRisk).toBe(false);
  });
});
