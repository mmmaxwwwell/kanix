import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "./db/connection.js";
import { order, orderStatusHistory, orderLine } from "./db/schema/order.js";
import { fulfillmentTask } from "./db/schema/fulfillment.js";
import { adminUser } from "./db/schema/admin.js";
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
  blockFulfillmentTask,
  unblockFulfillmentTask,
  cancelFulfillmentTask,
  findStaleFulfillmentTasks,
  FULFILLMENT_TASK_TRANSITIONS,
} from "./db/queries/fulfillment-task.js";

const DATABASE_URL = requireDatabaseUrl();

describe("fulfillment task integration (T056)", () => {
  let dbConn: DatabaseConnection;
  const ts = Date.now();
  const createdOrderIds: string[] = [];
  const createdTaskIds: string[] = [];
  const createdAdminIds: string[] = [];

  // Admin user IDs used throughout tests
  let adminId1: string;
  let adminId2: string;
  let adminId3: string;

  beforeAll(async () => {
    dbConn = createDatabaseConnection(DATABASE_URL);
    const db = dbConn.db;

    // Create admin_user records (FK target for fulfillment_task.assigned_admin_user_id)
    const admins = await db
      .insert(adminUser)
      .values([
        { authSubject: `t230-admin1-${ts}`, email: `admin1-${ts}@test.kanix.dev`, name: "T230 Admin 1" },
        { authSubject: `t230-admin2-${ts}`, email: `admin2-${ts}@test.kanix.dev`, name: "T230 Admin 2" },
        { authSubject: `t230-admin3-${ts}`, email: `admin3-${ts}@test.kanix.dev`, name: "T230 Admin 3" },
      ])
      .returning({ id: adminUser.id });
    adminId1 = admins[0].id;
    adminId2 = admins[1].id;
    adminId3 = admins[2].id;
    createdAdminIds.push(adminId1, adminId2, adminId3);
  });

  afterAll(async () => {
    if (dbConn) {
      const db = dbConn.db;
      // Clean up in reverse order of dependencies
      for (const taskId of createdTaskIds) {
        await db.delete(fulfillmentTask).where(eq(fulfillmentTask.id, taskId));
      }
      for (const orderId of createdOrderIds) {
        await db.delete(orderLine).where(eq(orderLine.orderId, orderId));
        await db.delete(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId));
        await db.delete(order).where(eq(order.id, orderId));
      }
      for (const adminId of createdAdminIds) {
        await db.delete(adminUser).where(eq(adminUser.id, adminId));
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

  // Helper to walk a task quickly to a target state
  async function walkTaskTo(
    taskId: string,
    target: "assigned" | "picking" | "picked" | "packing" | "packed" | "shipment_pending" | "done",
  ) {
    const steps: string[] = ["assigned", "picking", "picked", "packing", "packed", "shipment_pending", "done"];
    const targetIdx = steps.indexOf(target);
    // new → assigned via assign
    await assignFulfillmentTask(dbConn.db, taskId, adminId1);
    for (let i = 1; i <= targetIdx; i++) {
      await transitionFulfillmentTaskStatus(dbConn.db, {
        taskId,
        newStatus: steps[i],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Unit-level: state machine validation
  // -------------------------------------------------------------------------

  it("validates every legal forward transition in the state machine", () => {
    // Walk the happy path
    expect(isValidFulfillmentTaskTransition("new", "assigned")).toBe(true);
    expect(isValidFulfillmentTaskTransition("assigned", "picking")).toBe(true);
    expect(isValidFulfillmentTaskTransition("picking", "picked")).toBe(true);
    expect(isValidFulfillmentTaskTransition("picked", "packing")).toBe(true);
    expect(isValidFulfillmentTaskTransition("packing", "packed")).toBe(true);
    expect(isValidFulfillmentTaskTransition("packed", "shipment_pending")).toBe(true);
    expect(isValidFulfillmentTaskTransition("shipment_pending", "done")).toBe(true);
  });

  it("rejects invalid transitions (skipping states, backward, terminal)", () => {
    expect(isValidFulfillmentTaskTransition("new", "picking")).toBe(false);
    expect(isValidFulfillmentTaskTransition("new", "done")).toBe(false);
    expect(isValidFulfillmentTaskTransition("done", "new")).toBe(false);
    expect(isValidFulfillmentTaskTransition("canceled", "new")).toBe(false);
    expect(isValidFulfillmentTaskTransition("done", "assigned")).toBe(false);
    expect(isValidFulfillmentTaskTransition("canceled", "assigned")).toBe(false);
  });

  it("allows blocked transition from every active state", () => {
    const activeStates = ["new", "assigned", "picking", "picked", "packing", "packed", "shipment_pending"];
    for (const state of activeStates) {
      expect(isValidFulfillmentTaskTransition(state, "blocked")).toBe(true);
    }
  });

  it("allows canceled transition from pre-shipment states but not shipment_pending", () => {
    expect(isValidFulfillmentTaskTransition("new", "canceled")).toBe(true);
    expect(isValidFulfillmentTaskTransition("assigned", "canceled")).toBe(true);
    expect(isValidFulfillmentTaskTransition("picking", "canceled")).toBe(true);
    expect(isValidFulfillmentTaskTransition("picked", "canceled")).toBe(true);
    expect(isValidFulfillmentTaskTransition("packing", "canceled")).toBe(true);
    expect(isValidFulfillmentTaskTransition("packed", "canceled")).toBe(true);
    // shipment_pending cannot be canceled (label may already be purchased)
    expect(isValidFulfillmentTaskTransition("shipment_pending", "canceled")).toBe(false);
  });

  it("blocked state can recover to any active state or be canceled", () => {
    const targets = FULFILLMENT_TASK_TRANSITIONS["blocked"];
    expect(targets).toContain("new");
    expect(targets).toContain("assigned");
    expect(targets).toContain("picking");
    expect(targets).toContain("shipment_pending");
    expect(targets).toContain("canceled");
    // terminal states should not be targets except canceled
    expect(targets).not.toContain("done");
  });

  it("terminal states (done, canceled) have empty transition lists", () => {
    expect(FULFILLMENT_TASK_TRANSITIONS["done"]).toEqual([]);
    expect(FULFILLMENT_TASK_TRANSITIONS["canceled"]).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // SLA priority calculation
  // -------------------------------------------------------------------------

  it("order before cutoff → high priority with sla_at_risk", () => {
    const morning = new Date();
    morning.setHours(10, 0, 0, 0);
    const result = calculateFulfillmentPriority(morning);
    expect(result.priority).toBe("high");
    expect(result.slaAtRisk).toBe(true);
  });

  it("order after cutoff → normal priority, no sla_at_risk", () => {
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

    // With cutoff at 11 AM, 10 AM is BEFORE cutoff
    const result2 = calculateFulfillmentPriority(tenAM, 11);
    expect(result2.priority).toBe("high");
    expect(result2.slaAtRisk).toBe(true);
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
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(["normal", "high"]).toContain(result.priority);
    expect(typeof result.slaAtRisk).toBe("boolean");
  });

  it("rejects fulfillment task creation when payment_status is not paid", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({
      status: "pending_payment",
      paymentStatus: "unpaid",
      suffix: `${ts}-unpaid`,
    });

    await expect(createFulfillmentTaskForPaidOrder(db, testOrder.id)).rejects.toMatchObject({
      code: "ERR_PAYMENT_NOT_PAID",
    });
  });

  it("rejects fulfillment task creation for non-existent order", async () => {
    const db = dbConn.db;
    await expect(
      createFulfillmentTaskForPaidOrder(db, "00000000-0000-0000-0000-000000000099"),
    ).rejects.toMatchObject({
      code: "ERR_ORDER_NOT_FOUND",
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle: walk task through all states
  // -------------------------------------------------------------------------

  it("walks fulfillment task through full lifecycle: new → assigned → ... → done", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-lifecycle` });

    // Create task
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    expect(task.status).toBe("new");
    expect(task.orderId).toBe(testOrder.id);
    expect(task.priority).toBe("normal");
    expect(task.notes).toBeNull();
    expect(task.createdAt).toBeInstanceOf(Date);

    // new → assigned (via assign)
    const assigned = await assignFulfillmentTask(db, task.id, adminId1);
    expect(assigned.status).toBe("assigned");
    expect(assigned.assignedAdminUserId).toBe(adminId1);

    // assigned → picking — check oldStatus/newStatus for event tracking
    const picking = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "picking",
    });
    expect(picking.status).toBe("picking");
    expect(picking.oldStatus).toBe("assigned");
    expect(picking.newStatus).toBe("picking");
    expect(picking.orderId).toBe(testOrder.id);

    // picking → picked
    const picked = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "picked",
    });
    expect(picked.status).toBe("picked");
    expect(picked.oldStatus).toBe("picking");

    // picked → packing
    const packing = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "packing",
    });
    expect(packing.status).toBe("packing");
    expect(packing.oldStatus).toBe("picked");

    // packing → packed
    const packed = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "packed",
    });
    expect(packed.status).toBe("packed");
    expect(packed.oldStatus).toBe("packing");

    // packed → shipment_pending
    const shipmentPending = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "shipment_pending",
    });
    expect(shipmentPending.status).toBe("shipment_pending");
    expect(shipmentPending.oldStatus).toBe("packed");

    // shipment_pending → done
    const done = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "done",
    });
    expect(done.status).toBe("done");
    expect(done.oldStatus).toBe("shipment_pending");
    expect(done.newStatus).toBe("done");

    // Verify final persisted state
    const finalTask = await findFulfillmentTaskById(db, task.id);
    expect(finalTask).not.toBeNull();
    expect(finalTask!.status).toBe("done");
    expect(finalTask!.orderId).toBe(testOrder.id);
    expect(finalTask!.assignedAdminUserId).toBe(adminId1);
  });

  // -------------------------------------------------------------------------
  // Transition return values carry audit-relevant oldStatus/newStatus
  // -------------------------------------------------------------------------

  it("every transition returns oldStatus and newStatus for event tracking", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-events` });
    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await assignFulfillmentTask(db, task.id, adminId1);

    const result = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "picking",
    });
    // These fields are used by server routes to populate audit log entries
    expect(result).toHaveProperty("oldStatus", "assigned");
    expect(result).toHaveProperty("newStatus", "picking");
    expect(result).toHaveProperty("id", task.id);
    expect(result).toHaveProperty("orderId", testOrder.id);
    expect(result).toHaveProperty("priority");
    expect(result).toHaveProperty("assignedAdminUserId", adminId1);
    expect(result).toHaveProperty("blockedReason", null);
    expect(result).toHaveProperty("preBlockedStatus", null);
  });

  // -------------------------------------------------------------------------
  // Invalid transitions rejected
  // -------------------------------------------------------------------------

  it("rejects invalid transition: new → done", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-invalid1` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await expect(
      transitionFulfillmentTaskStatus(db, {
        taskId: task.id,
        newStatus: "done",
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
      from: "new",
      to: "done",
    });
  });

  it("rejects transition from done state (terminal)", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-done` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    await walkTaskTo(task.id, "done");

    await expect(
      transitionFulfillmentTaskStatus(db, {
        taskId: task.id,
        newStatus: "new",
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
      from: "done",
      to: "new",
    });
  });

  it("rejects transition from canceled state (terminal)", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-canceled-term` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "canceled",
    });

    await expect(
      transitionFulfillmentTaskStatus(db, {
        taskId: task.id,
        newStatus: "new",
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
      from: "canceled",
      to: "new",
    });
  });

  it("rejects transition for non-existent task", async () => {
    const db = dbConn.db;
    await expect(
      transitionFulfillmentTaskStatus(db, {
        taskId: "00000000-0000-0000-0000-000000000099",
        newStatus: "assigned",
      }),
    ).rejects.toMatchObject({
      code: "ERR_TASK_NOT_FOUND",
    });
  });

  // -------------------------------------------------------------------------
  // Blocked state — requires reason, stores preBlockedStatus
  // -------------------------------------------------------------------------

  it("transitions to blocked, stores reason and preBlockedStatus", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-blocked1` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await assignFulfillmentTask(db, task.id, adminId1);
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picking" });

    const blocked = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "blocked",
      reason: "Out of stock on item #42",
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.oldStatus).toBe("picking");
    expect(blocked.blockedReason).toBe("Out of stock on item #42");
    expect(blocked.preBlockedStatus).toBe("picking");

    // Verify persisted
    const persisted = await findFulfillmentTaskById(db, task.id);
    expect(persisted!.status).toBe("blocked");
    expect(persisted!.blockedReason).toBe("Out of stock on item #42");
    expect(persisted!.preBlockedStatus).toBe("picking");
  });

  it("rejects block transition without reason", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-noreason` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await expect(
      transitionFulfillmentTaskStatus(db, {
        taskId: task.id,
        newStatus: "blocked",
        // no reason
      }),
    ).rejects.toMatchObject({
      code: "ERR_REASON_REQUIRED",
    });
  });

  it("recovers from blocked back to pre-blocked state", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-recover` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await assignFulfillmentTask(db, task.id, adminId1);
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picking" });

    // Block from picking
    await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "blocked",
      reason: "Inventory issue",
    });

    // Recover back to picking
    const recovered = await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "picking",
    });
    expect(recovered.status).toBe("picking");
    expect(recovered.oldStatus).toBe("blocked");
    expect(recovered.blockedReason).toBeNull();
    expect(recovered.preBlockedStatus).toBeNull();
  });

  // -------------------------------------------------------------------------
  // blockFulfillmentTask helper
  // -------------------------------------------------------------------------

  it("blockFulfillmentTask blocks task and returns structured result", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-blockhelper` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    await assignFulfillmentTask(db, task.id, adminId1);

    const result = await blockFulfillmentTask(db, {
      taskId: task.id,
      reason: "Missing component",
      actorAdminUserId: adminId1,
    });

    expect(result.task.status).toBe("blocked");
    expect(result.task.oldStatus).toBe("assigned");
    expect(result.task.blockedReason).toBe("Missing component");
    expect(result.task.preBlockedStatus).toBe("assigned");
    expect(result.inventoryAdjustmentResult).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // unblockFulfillmentTask helper
  // -------------------------------------------------------------------------

  it("unblockFulfillmentTask returns to pre-blocked state", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-unblock` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await assignFulfillmentTask(db, task.id, adminId1);
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picking" });
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picked" });
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "packing" });

    // Block from packing
    await blockFulfillmentTask(db, {
      taskId: task.id,
      reason: "Wrong label",
      actorAdminUserId: adminId1,
    });

    // Unblock
    const result = await unblockFulfillmentTask(db, task.id);
    expect(result.status).toBe("packing");
    expect(result.oldStatus).toBe("blocked");
    expect(result.blockedReason).toBeNull();
    expect(result.preBlockedStatus).toBeNull();
  });

  it("unblockFulfillmentTask rejects when task is not blocked", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-unblockfail` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await expect(unblockFulfillmentTask(db, task.id)).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  it("unblockFulfillmentTask rejects for non-existent task", async () => {
    const db = dbConn.db;
    await expect(
      unblockFulfillmentTask(db, "00000000-0000-0000-0000-000000000099"),
    ).rejects.toMatchObject({
      code: "ERR_TASK_NOT_FOUND",
    });
  });

  // -------------------------------------------------------------------------
  // cancelFulfillmentTask — pre-picking (no inventory return)
  // -------------------------------------------------------------------------

  it("cancelFulfillmentTask from pre-picking state does not create inventory adjustments", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-cancel-pre` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    const result = await cancelFulfillmentTask(db, {
      taskId: task.id,
      reason: "Customer request",
      actorAdminUserId: adminId1,
      locationId: adminId1,
    });

    expect(result.task.status).toBe("canceled");
    expect(result.task.oldStatus).toBe("new");
    expect(result.task.newStatus).toBe("canceled");
    expect(result.inventoryAdjustments).toHaveLength(0);

    // Verify final persisted state
    const persisted = await findFulfillmentTaskById(db, task.id);
    expect(persisted!.status).toBe("canceled");
  });

  it("cancelFulfillmentTask rejects from shipment_pending (label in play)", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-cancel-ship` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    await walkTaskTo(task.id, "shipment_pending");

    await expect(
      cancelFulfillmentTask(db, {
        taskId: task.id,
        reason: "Too late",
        actorAdminUserId: adminId1,
        locationId: adminId1,
      }),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  // -------------------------------------------------------------------------
  // Assignment API
  // -------------------------------------------------------------------------

  it("assigns a task and transitions new → assigned with correct fields", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-assign1` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    expect(task.status).toBe("new");

    const result = await assignFulfillmentTask(db, task.id, adminId2);
    expect(result.status).toBe("assigned");
    expect(result.assignedAdminUserId).toBe(adminId2);
    expect(result.id).toBe(task.id);
    expect(result.orderId).toBe(testOrder.id);
    expect(result.priority).toBe("normal");
  });

  it("re-assigns an already-in-progress task without changing status", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-reassign` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await assignFulfillmentTask(db, task.id, adminId1);
    await transitionFulfillmentTaskStatus(db, { taskId: task.id, newStatus: "picking" });

    // Re-assign to different admin while in picking status
    const result = await assignFulfillmentTask(db, task.id, adminId2);
    expect(result.status).toBe("picking"); // status unchanged
    expect(result.assignedAdminUserId).toBe(adminId2);

    // Verify persisted
    const persisted = await findFulfillmentTaskById(db, task.id);
    expect(persisted!.assignedAdminUserId).toBe(adminId2);
    expect(persisted!.status).toBe("picking");
  });

  it("rejects assignment of done task", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-assign-done` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    await walkTaskTo(task.id, "done");

    await expect(
      assignFulfillmentTask(db, task.id, adminId2),
    ).rejects.toMatchObject({
      code: "ERR_INVALID_TRANSITION",
    });
  });

  it("rejects assignment of non-existent task", async () => {
    const db = dbConn.db;
    await expect(
      assignFulfillmentTask(db, "00000000-0000-0000-0000-000000000099", adminId1),
    ).rejects.toMatchObject({
      code: "ERR_TASK_NOT_FOUND",
    });
  });

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  it("findFulfillmentTaskById returns full task object", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-findbyid` });

    const task = await createFulfillmentTask(db, {
      orderId: testOrder.id,
      priority: "high",
      notes: "Rush order",
    });
    createdTaskIds.push(task.id);

    const found = await findFulfillmentTaskById(db, task.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);
    expect(found!.orderId).toBe(testOrder.id);
    expect(found!.status).toBe("new");
    expect(found!.priority).toBe("high");
    expect(found!.notes).toBe("Rush order");
    expect(found!.assignedAdminUserId).toBeNull();
    expect(found!.blockedReason).toBeNull();
    expect(found!.preBlockedStatus).toBeNull();
    expect(found!.createdAt).toBeInstanceOf(Date);
    expect(found!.updatedAt).toBeInstanceOf(Date);
  });

  it("findFulfillmentTaskById returns null for non-existent task", async () => {
    const db = dbConn.db;
    const found = await findFulfillmentTaskById(db, "00000000-0000-0000-0000-000000000099");
    expect(found).toBeNull();
  });

  it("finds fulfillment tasks by order ID", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-findbyorder` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    const tasks = await findFulfillmentTasksByOrderId(db, testOrder.id);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const match = tasks.find((t) => t.id === task.id);
    expect(match).toBeDefined();
    expect(match!.orderId).toBe(testOrder.id);
    expect(match!.status).toBe("new");
    expect(match!.createdAt).toBeInstanceOf(Date);
  });

  it("lists fulfillment tasks with status filter", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-list-status` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    const newTasks = await listFulfillmentTasks(db, { status: "new" });
    expect(newTasks.some((t) => t.id === task.id)).toBe(true);

    const doneTasks = await listFulfillmentTasks(db, { status: "done" });
    expect(doneTasks.some((t) => t.id === task.id)).toBe(false);
  });

  it("lists fulfillment tasks with priority filter", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-list-prio` });

    const task = await createFulfillmentTask(db, {
      orderId: testOrder.id,
      priority: "urgent",
    });
    createdTaskIds.push(task.id);

    const urgentTasks = await listFulfillmentTasks(db, { priority: "urgent" });
    expect(urgentTasks.some((t) => t.id === task.id)).toBe(true);

    const normalTasks = await listFulfillmentTasks(db, { priority: "normal" });
    expect(normalTasks.some((t) => t.id === task.id)).toBe(false);
  });

  it("lists fulfillment tasks with assignedAdminUserId filter", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-list-admin` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    const adminId = adminId3;
    await assignFulfillmentTask(db, task.id, adminId);

    const adminTasks = await listFulfillmentTasks(db, { assignedAdminUserId: adminId });
    expect(adminTasks.some((t) => t.id === task.id)).toBe(true);

    const otherTasks = await listFulfillmentTasks(db, {
      assignedAdminUserId: "00000000-0000-0000-0000-000000000099",
    });
    expect(otherTasks.some((t) => t.id === task.id)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // SLA priority on task creation
  // -------------------------------------------------------------------------

  it("paid order before cutoff gets high priority fulfillment task with SLA note", async () => {
    const db = dbConn.db;
    const morning = new Date();
    morning.setHours(9, 0, 0, 0);

    const testOrder = await createTestOrder({
      suffix: `${ts}-sla-high`,
      placedAt: morning,
    });

    const result = await createFulfillmentTaskForPaidOrder(db, testOrder.id);
    createdTaskIds.push(result.id);

    expect(result.priority).toBe("high");
    expect(result.slaAtRisk).toBe(true);

    // Verify the note was persisted
    const persisted = await findFulfillmentTaskById(db, result.id);
    expect(persisted!.notes).toBe("SLA at risk: next-day delivery required");
  });

  it("paid order after cutoff gets normal priority with no SLA note", async () => {
    const db = dbConn.db;
    const afternoon = new Date();
    afternoon.setHours(16, 0, 0, 0);

    const testOrder = await createTestOrder({
      suffix: `${ts}-sla-normal`,
      placedAt: afternoon,
    });

    const result = await createFulfillmentTaskForPaidOrder(db, testOrder.id);
    createdTaskIds.push(result.id);

    expect(result.priority).toBe("normal");
    expect(result.slaAtRisk).toBe(false);

    const persisted = await findFulfillmentTaskById(db, result.id);
    expect(persisted!.notes).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Stale (abandoned) task detection — flagged for admin review
  // -------------------------------------------------------------------------

  it("findStaleFulfillmentTasks returns tasks not updated within threshold", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-stale` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Backdate the updatedAt to simulate a stale task (5 hours ago)
    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000);
    await db
      .update(fulfillmentTask)
      .set({ updatedAt: staleTime })
      .where(eq(fulfillmentTask.id, task.id));

    // With 4-hour threshold (default), this task should be stale
    const staleTasks = await findStaleFulfillmentTasks(db);
    const match = staleTasks.find((t) => t.id === task.id);
    expect(match).toBeDefined();
    expect(match!.status).toBe("new");
    expect(match!.orderId).toBe(testOrder.id);
  });

  it("findStaleFulfillmentTasks does not return recently updated tasks", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-notstale` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Task just created — should NOT be stale with 4-hour threshold
    const staleTasks = await findStaleFulfillmentTasks(db);
    expect(staleTasks.some((t) => t.id === task.id)).toBe(false);
  });

  it("findStaleFulfillmentTasks does not return terminal (done/canceled) tasks", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-stale-done` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);
    await walkTaskTo(task.id, "done");

    // Backdate to make it look old
    const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db
      .update(fulfillmentTask)
      .set({ updatedAt: staleTime })
      .where(eq(fulfillmentTask.id, task.id));

    const staleTasks = await findStaleFulfillmentTasks(db);
    expect(staleTasks.some((t) => t.id === task.id)).toBe(false);
  });

  it("findStaleFulfillmentTasks supports custom threshold", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-stale-custom` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    // Backdate 30 minutes
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    await db
      .update(fulfillmentTask)
      .set({ updatedAt: thirtyMinAgo })
      .where(eq(fulfillmentTask.id, task.id));

    // With 4-hour threshold → not stale
    const notStale = await findStaleFulfillmentTasks(db, 4 * 60 * 60 * 1000);
    expect(notStale.some((t) => t.id === task.id)).toBe(false);

    // With 15-minute threshold → stale
    const stale = await findStaleFulfillmentTasks(db, 15 * 60 * 1000);
    expect(stale.some((t) => t.id === task.id)).toBe(true);
  });

  it("findStaleFulfillmentTasks includes blocked tasks", async () => {
    const db = dbConn.db;
    const testOrder = await createTestOrder({ suffix: `${ts}-stale-blocked` });

    const task = await createFulfillmentTask(db, { orderId: testOrder.id });
    createdTaskIds.push(task.id);

    await transitionFulfillmentTaskStatus(db, {
      taskId: task.id,
      newStatus: "blocked",
      reason: "Waiting for restock",
    });

    // Backdate
    const staleTime = new Date(Date.now() - 5 * 60 * 60 * 1000);
    await db
      .update(fulfillmentTask)
      .set({ updatedAt: staleTime })
      .where(eq(fulfillmentTask.id, task.id));

    const staleTasks = await findStaleFulfillmentTasks(db);
    const match = staleTasks.find((t) => t.id === task.id);
    expect(match).toBeDefined();
    expect(match!.status).toBe("blocked");
    expect(match!.blockedReason).toBe("Waiting for restock");
  });
});
