import { eq, and, desc, lt, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { fulfillmentTask } from "../schema/fulfillment.js";
import { order, orderLine } from "../schema/order.js";
import { transitionOrderStatus } from "./order-state-machine.js";
import { createInventoryAdjustment } from "./inventory.js";

// ---------------------------------------------------------------------------
// Fulfillment task status values and state machine (6.D)
// ---------------------------------------------------------------------------

export const FULFILLMENT_TASK_STATUSES = [
  "new",
  "assigned",
  "picking",
  "picked",
  "packing",
  "packed",
  "shipment_pending",
  "done",
  "blocked",
  "canceled",
] as const;
export type FulfillmentTaskStatus = (typeof FULFILLMENT_TASK_STATUSES)[number];

export const FULFILLMENT_TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type FulfillmentTaskPriority = (typeof FULFILLMENT_TASK_PRIORITIES)[number];

// Active states (can transition to blocked)
const ACTIVE_STATES: readonly string[] = [
  "new",
  "assigned",
  "picking",
  "picked",
  "packing",
  "packed",
  "shipment_pending",
];

/** fulfillment_task.status transitions (6.D) */
export const FULFILLMENT_TASK_TRANSITIONS: Record<string, string[]> = {
  new: ["assigned", "blocked", "canceled"],
  assigned: ["picking", "blocked", "canceled"],
  picking: ["picked", "blocked", "canceled"],
  picked: ["packing", "blocked", "canceled"],
  packing: ["packed", "blocked", "canceled"],
  packed: ["shipment_pending", "blocked", "canceled"],
  shipment_pending: ["done", "blocked"],
  done: [],
  blocked: [...ACTIVE_STATES, "canceled"], // blocked can recover to any active state, or be canceled
  canceled: [],
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isValidFulfillmentTaskTransition(from: string, to: string): boolean {
  const allowed = FULFILLMENT_TASK_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

// ---------------------------------------------------------------------------
// SLA priority calculation
// ---------------------------------------------------------------------------

/**
 * Determines the priority for a fulfillment task based on order confirmation time.
 * Orders confirmed before the cutoff (default 14:00 local) get priority=high.
 */
export function calculateFulfillmentPriority(
  orderPlacedAt: Date,
  cutoffHour = 14,
): { priority: FulfillmentTaskPriority; slaAtRisk: boolean } {
  const orderHour = orderPlacedAt.getHours();
  if (orderHour < cutoffHour) {
    return { priority: "high", slaAtRisk: true };
  }
  return { priority: "normal", slaAtRisk: false };
}

// ---------------------------------------------------------------------------
// Create fulfillment task
// ---------------------------------------------------------------------------

export interface CreateFulfillmentTaskInput {
  orderId: string;
  priority?: FulfillmentTaskPriority;
  notes?: string;
}

export async function createFulfillmentTask(
  db: PostgresJsDatabase,
  input: CreateFulfillmentTaskInput,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  priority: string;
  notes: string | null;
  createdAt: Date;
}> {
  const [row] = await db
    .insert(fulfillmentTask)
    .values({
      orderId: input.orderId,
      status: "new",
      priority: input.priority ?? "normal",
      notes: input.notes ?? null,
    })
    .returning({
      id: fulfillmentTask.id,
      orderId: fulfillmentTask.orderId,
      status: fulfillmentTask.status,
      priority: fulfillmentTask.priority,
      notes: fulfillmentTask.notes,
      createdAt: fulfillmentTask.createdAt,
    });
  return row;
}

// ---------------------------------------------------------------------------
// Auto-create fulfillment task when payment succeeds
// ---------------------------------------------------------------------------

/**
 * Called after order.payment_status transitions to paid.
 * Creates a fulfillment task with SLA-based priority.
 */
export async function createFulfillmentTaskForPaidOrder(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  priority: string;
  slaAtRisk: boolean;
}> {
  // Fetch the order to check payment status and placed_at
  const [orderRow] = await db
    .select({
      id: order.id,
      paymentStatus: order.paymentStatus,
      placedAt: order.placedAt,
    })
    .from(order)
    .where(eq(order.id, orderId));

  if (!orderRow) {
    throw { code: "ERR_ORDER_NOT_FOUND", message: `Order ${orderId} not found` };
  }

  if (orderRow.paymentStatus !== "paid") {
    throw {
      code: "ERR_PAYMENT_NOT_PAID",
      message: `Cannot create fulfillment task: order payment_status is ${orderRow.paymentStatus}, expected paid`,
    };
  }

  // Calculate SLA priority based on when the order was placed
  const placedAt = orderRow.placedAt ?? new Date();
  const { priority, slaAtRisk } = calculateFulfillmentPriority(placedAt);

  const slaNote = slaAtRisk ? "SLA at risk: next-day delivery required" : undefined;

  const task = await createFulfillmentTask(db, {
    orderId,
    priority,
    notes: slaNote,
  });

  // Transition fulfillment_status to queued
  try {
    await transitionOrderStatus(db, {
      orderId,
      statusType: "fulfillment_status",
      newValue: "queued",
      reason: "Fulfillment task created after payment confirmed",
    });
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error.code !== "ERR_INVALID_TRANSITION") throw err;
    // Already queued — idempotent
  }

  return {
    id: task.id,
    orderId: task.orderId,
    status: task.status,
    priority: task.priority,
    slaAtRisk,
  };
}

// ---------------------------------------------------------------------------
// Transition fulfillment task status
// ---------------------------------------------------------------------------

export interface TransitionFulfillmentTaskInput {
  taskId: string;
  newStatus: string;
  reason?: string;
  actorAdminUserId?: string;
}

// States that have passed the picking phase (items physically handled)
const POST_PICKING_STATES: readonly string[] = ["picked", "packing", "packed", "shipment_pending"];

export async function transitionFulfillmentTaskStatus(
  db: PostgresJsDatabase,
  input: TransitionFulfillmentTaskInput,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  priority: string;
  assignedAdminUserId: string | null;
  blockedReason: string | null;
  preBlockedStatus: string | null;
  oldStatus: string;
  newStatus: string;
}> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: fulfillmentTask.id,
        orderId: fulfillmentTask.orderId,
        status: fulfillmentTask.status,
        priority: fulfillmentTask.priority,
        assignedAdminUserId: fulfillmentTask.assignedAdminUserId,
        preBlockedStatus: fulfillmentTask.preBlockedStatus,
      })
      .from(fulfillmentTask)
      .where(eq(fulfillmentTask.id, input.taskId));

    if (!current) {
      throw { code: "ERR_TASK_NOT_FOUND", message: `Fulfillment task ${input.taskId} not found` };
    }

    if (!isValidFulfillmentTaskTransition(current.status, input.newStatus)) {
      throw {
        code: "ERR_INVALID_TRANSITION",
        message: `Invalid fulfillment task transition: ${current.status} → ${input.newStatus}`,
        from: current.status,
        to: input.newStatus,
      };
    }

    // Require reason when transitioning to blocked
    if (input.newStatus === "blocked" && !input.reason) {
      throw {
        code: "ERR_REASON_REQUIRED",
        message: "A reason is required when blocking a fulfillment task",
      };
    }

    const updateSet: Record<string, unknown> = {
      status: input.newStatus,
      updatedAt: new Date(),
    };

    if (input.newStatus === "blocked") {
      // Store the current state so we can return to it on unblock
      updateSet.blockedReason = input.reason ?? "";
      updateSet.preBlockedStatus = current.status;
    } else if (current.status === "blocked") {
      // Unblocking — clear blocked fields
      updateSet.blockedReason = null;
      updateSet.preBlockedStatus = null;
    }

    await tx.update(fulfillmentTask).set(updateSet).where(eq(fulfillmentTask.id, input.taskId));

    return {
      id: current.id,
      orderId: current.orderId,
      status: input.newStatus,
      priority: current.priority,
      assignedAdminUserId: current.assignedAdminUserId,
      blockedReason: input.newStatus === "blocked" ? (input.reason ?? null) : null,
      preBlockedStatus: input.newStatus === "blocked" ? current.status : null,
      oldStatus: current.status,
      newStatus: input.newStatus,
    };
  });
}

// ---------------------------------------------------------------------------
// Block fulfillment task (with optional inventory adjustment)
// ---------------------------------------------------------------------------

export interface BlockFulfillmentTaskInput {
  taskId: string;
  reason: string;
  actorAdminUserId?: string;
  inventoryAdjustment?: {
    variantId: string;
    locationId: string;
    adjustmentType: "shrinkage" | "correction" | "damage";
    quantityDelta: number;
  };
}

export async function blockFulfillmentTask(
  db: PostgresJsDatabase,
  input: BlockFulfillmentTaskInput,
): Promise<{
  task: {
    id: string;
    orderId: string;
    status: string;
    priority: string;
    blockedReason: string | null;
    preBlockedStatus: string | null;
    oldStatus: string;
    newStatus: string;
  };
  inventoryAdjustmentResult?: Awaited<ReturnType<typeof createInventoryAdjustment>>;
}> {
  const taskResult = await transitionFulfillmentTaskStatus(db, {
    taskId: input.taskId,
    newStatus: "blocked",
    reason: input.reason,
    actorAdminUserId: input.actorAdminUserId,
  });

  let inventoryAdjustmentResult;
  if (input.inventoryAdjustment && input.actorAdminUserId) {
    inventoryAdjustmentResult = await createInventoryAdjustment(db, {
      variantId: input.inventoryAdjustment.variantId,
      locationId: input.inventoryAdjustment.locationId,
      adjustmentType: input.inventoryAdjustment.adjustmentType,
      quantityDelta: input.inventoryAdjustment.quantityDelta,
      reason: `Inventory discrepancy found during fulfillment task ${input.taskId}: ${input.reason}`,
      actorAdminUserId: input.actorAdminUserId,
      relatedOrderId: taskResult.orderId,
      idempotencyKey: `block-${input.taskId}-${Date.now()}`,
    });
  }

  return { task: taskResult, inventoryAdjustmentResult };
}

// ---------------------------------------------------------------------------
// Unblock fulfillment task (returns to previous active state)
// ---------------------------------------------------------------------------

export async function unblockFulfillmentTask(
  db: PostgresJsDatabase,
  taskId: string,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  priority: string;
  blockedReason: string | null;
  preBlockedStatus: string | null;
  oldStatus: string;
  newStatus: string;
}> {
  // First, get the task to find the preBlockedStatus
  const task = await findFulfillmentTaskById(db, taskId);
  if (!task) {
    throw { code: "ERR_TASK_NOT_FOUND", message: `Fulfillment task ${taskId} not found` };
  }
  if (task.status !== "blocked") {
    throw {
      code: "ERR_INVALID_TRANSITION",
      message: `Cannot unblock task: current status is ${task.status}, expected blocked`,
    };
  }

  const targetStatus = task.preBlockedStatus ?? "new";
  return transitionFulfillmentTaskStatus(db, {
    taskId,
    newStatus: targetStatus,
  });
}

// ---------------------------------------------------------------------------
// Cancel fulfillment task (with auto inventory return after picking)
// ---------------------------------------------------------------------------

export async function cancelFulfillmentTask(
  db: PostgresJsDatabase,
  input: {
    taskId: string;
    reason?: string;
    actorAdminUserId?: string;
    locationId: string;
  },
): Promise<{
  task: {
    id: string;
    orderId: string;
    status: string;
    oldStatus: string;
    newStatus: string;
  };
  inventoryAdjustments: Awaited<ReturnType<typeof createInventoryAdjustment>>[];
}> {
  // Get the current task to check if items were picked
  const task = await findFulfillmentTaskById(db, input.taskId);
  if (!task) {
    throw { code: "ERR_TASK_NOT_FOUND", message: `Fulfillment task ${input.taskId} not found` };
  }

  const wasPicked =
    POST_PICKING_STATES.includes(task.status) ||
    (task.status === "blocked" &&
      task.preBlockedStatus !== null &&
      POST_PICKING_STATES.includes(task.preBlockedStatus));

  const taskResult = await transitionFulfillmentTaskStatus(db, {
    taskId: input.taskId,
    newStatus: "canceled",
    reason: input.reason,
    actorAdminUserId: input.actorAdminUserId,
  });

  const inventoryAdjustments: Awaited<ReturnType<typeof createInventoryAdjustment>>[] = [];

  // Auto-create inventory adjustments to return picked items if post-picking
  if (wasPicked && input.actorAdminUserId) {
    // Get order lines to know what was picked
    const lines = await db
      .select({
        variantId: orderLine.variantId,
        quantity: orderLine.quantity,
      })
      .from(orderLine)
      .where(eq(orderLine.orderId, taskResult.orderId));

    for (const line of lines) {
      const adj = await createInventoryAdjustment(db, {
        variantId: line.variantId,
        locationId: input.locationId,
        adjustmentType: "return",
        quantityDelta: line.quantity,
        reason: `Auto-return: fulfillment task ${input.taskId} canceled after picking`,
        actorAdminUserId: input.actorAdminUserId,
        relatedOrderId: taskResult.orderId,
        idempotencyKey: `cancel-return-${input.taskId}-${line.variantId}`,
      });
      inventoryAdjustments.push(adj);
    }
  }

  return { task: taskResult, inventoryAdjustments };
}

// ---------------------------------------------------------------------------
// Assign fulfillment task
// ---------------------------------------------------------------------------

export async function assignFulfillmentTask(
  db: PostgresJsDatabase,
  taskId: string,
  adminUserId: string,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  priority: string;
  assignedAdminUserId: string | null;
}> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: fulfillmentTask.id,
        orderId: fulfillmentTask.orderId,
        status: fulfillmentTask.status,
        priority: fulfillmentTask.priority,
        assignedAdminUserId: fulfillmentTask.assignedAdminUserId,
      })
      .from(fulfillmentTask)
      .where(eq(fulfillmentTask.id, taskId));

    if (!current) {
      throw { code: "ERR_TASK_NOT_FOUND", message: `Fulfillment task ${taskId} not found` };
    }

    // Assignment transitions task from new → assigned
    if (current.status === "new") {
      await tx
        .update(fulfillmentTask)
        .set({
          status: "assigned",
          assignedAdminUserId: adminUserId,
          updatedAt: new Date(),
        })
        .where(eq(fulfillmentTask.id, taskId));

      return {
        id: current.id,
        orderId: current.orderId,
        status: "assigned",
        priority: current.priority,
        assignedAdminUserId: adminUserId,
      };
    }

    // Re-assignment without status change (task is already assigned or in progress)
    if (ACTIVE_STATES.includes(current.status) && current.status !== "new") {
      await tx
        .update(fulfillmentTask)
        .set({
          assignedAdminUserId: adminUserId,
          updatedAt: new Date(),
        })
        .where(eq(fulfillmentTask.id, taskId));

      return {
        id: current.id,
        orderId: current.orderId,
        status: current.status,
        priority: current.priority,
        assignedAdminUserId: adminUserId,
      };
    }

    throw {
      code: "ERR_INVALID_TRANSITION",
      message: `Cannot assign task in ${current.status} status`,
    };
  });
}

// ---------------------------------------------------------------------------
// Find fulfillment task by ID
// ---------------------------------------------------------------------------

export async function findFulfillmentTaskById(
  db: PostgresJsDatabase,
  taskId: string,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  priority: string;
  assignedAdminUserId: string | null;
  notes: string | null;
  blockedReason: string | null;
  preBlockedStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
} | null> {
  const [row] = await db
    .select({
      id: fulfillmentTask.id,
      orderId: fulfillmentTask.orderId,
      status: fulfillmentTask.status,
      priority: fulfillmentTask.priority,
      assignedAdminUserId: fulfillmentTask.assignedAdminUserId,
      notes: fulfillmentTask.notes,
      blockedReason: fulfillmentTask.blockedReason,
      preBlockedStatus: fulfillmentTask.preBlockedStatus,
      createdAt: fulfillmentTask.createdAt,
      updatedAt: fulfillmentTask.updatedAt,
    })
    .from(fulfillmentTask)
    .where(eq(fulfillmentTask.id, taskId));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Find fulfillment tasks by order ID
// ---------------------------------------------------------------------------

export async function findFulfillmentTasksByOrderId(
  db: PostgresJsDatabase,
  orderId: string,
): Promise<
  {
    id: string;
    orderId: string;
    status: string;
    priority: string;
    assignedAdminUserId: string | null;
    notes: string | null;
    blockedReason: string | null;
    preBlockedStatus: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[]
> {
  return db
    .select({
      id: fulfillmentTask.id,
      orderId: fulfillmentTask.orderId,
      status: fulfillmentTask.status,
      priority: fulfillmentTask.priority,
      assignedAdminUserId: fulfillmentTask.assignedAdminUserId,
      notes: fulfillmentTask.notes,
      blockedReason: fulfillmentTask.blockedReason,
      preBlockedStatus: fulfillmentTask.preBlockedStatus,
      createdAt: fulfillmentTask.createdAt,
      updatedAt: fulfillmentTask.updatedAt,
    })
    .from(fulfillmentTask)
    .where(eq(fulfillmentTask.orderId, orderId))
    .orderBy(desc(fulfillmentTask.createdAt));
}

// ---------------------------------------------------------------------------
// List fulfillment tasks with optional filters
// ---------------------------------------------------------------------------

export async function listFulfillmentTasks(
  db: PostgresJsDatabase,
  filters?: {
    status?: string;
    priority?: string;
    assignedAdminUserId?: string;
  },
): Promise<
  {
    id: string;
    orderId: string;
    status: string;
    priority: string;
    assignedAdminUserId: string | null;
    notes: string | null;
    blockedReason: string | null;
    preBlockedStatus: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[]
> {
  const conditions = [];
  if (filters?.status) {
    conditions.push(eq(fulfillmentTask.status, filters.status));
  }
  if (filters?.priority) {
    conditions.push(eq(fulfillmentTask.priority, filters.priority));
  }
  if (filters?.assignedAdminUserId) {
    conditions.push(eq(fulfillmentTask.assignedAdminUserId, filters.assignedAdminUserId));
  }

  const query = db
    .select({
      id: fulfillmentTask.id,
      orderId: fulfillmentTask.orderId,
      status: fulfillmentTask.status,
      priority: fulfillmentTask.priority,
      assignedAdminUserId: fulfillmentTask.assignedAdminUserId,
      notes: fulfillmentTask.notes,
      blockedReason: fulfillmentTask.blockedReason,
      preBlockedStatus: fulfillmentTask.preBlockedStatus,
      createdAt: fulfillmentTask.createdAt,
      updatedAt: fulfillmentTask.updatedAt,
    })
    .from(fulfillmentTask)
    .orderBy(desc(fulfillmentTask.createdAt));

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }

  return query;
}

// ---------------------------------------------------------------------------
// Find stale fulfillment tasks (active but not updated within threshold)
// ---------------------------------------------------------------------------

/**
 * Returns fulfillment tasks that have been in an active (non-terminal) state
 * for longer than `thresholdMs` without an update. These are candidates for
 * admin review — the task may be abandoned or stuck.
 */
export async function findStaleFulfillmentTasks(
  db: PostgresJsDatabase,
  thresholdMs: number = 4 * 60 * 60 * 1000, // default 4 hours
): Promise<
  {
    id: string;
    orderId: string;
    status: string;
    priority: string;
    assignedAdminUserId: string | null;
    notes: string | null;
    blockedReason: string | null;
    preBlockedStatus: string | null;
    createdAt: Date;
    updatedAt: Date;
  }[]
> {
  const cutoff = new Date(Date.now() - thresholdMs);
  return db
    .select({
      id: fulfillmentTask.id,
      orderId: fulfillmentTask.orderId,
      status: fulfillmentTask.status,
      priority: fulfillmentTask.priority,
      assignedAdminUserId: fulfillmentTask.assignedAdminUserId,
      notes: fulfillmentTask.notes,
      blockedReason: fulfillmentTask.blockedReason,
      preBlockedStatus: fulfillmentTask.preBlockedStatus,
      createdAt: fulfillmentTask.createdAt,
      updatedAt: fulfillmentTask.updatedAt,
    })
    .from(fulfillmentTask)
    .where(
      and(
        inArray(fulfillmentTask.status, [...ACTIVE_STATES, "blocked"]),
        lt(fulfillmentTask.updatedAt, cutoff),
      ),
    )
    .orderBy(fulfillmentTask.updatedAt);
}
