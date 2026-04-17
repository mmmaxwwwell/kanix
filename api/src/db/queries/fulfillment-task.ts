import { eq, and, desc } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { fulfillmentTask } from "../schema/fulfillment.js";
import { order } from "../schema/order.js";
import { transitionOrderStatus } from "./order-state-machine.js";

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
  blocked: [...ACTIVE_STATES], // blocked can go back to any active state
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

export async function transitionFulfillmentTaskStatus(
  db: PostgresJsDatabase,
  input: TransitionFulfillmentTaskInput,
): Promise<{
  id: string;
  orderId: string;
  status: string;
  priority: string;
  assignedAdminUserId: string | null;
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

    await tx
      .update(fulfillmentTask)
      .set({
        status: input.newStatus,
        updatedAt: new Date(),
      })
      .where(eq(fulfillmentTask.id, input.taskId));

    return {
      id: current.id,
      orderId: current.orderId,
      status: input.newStatus,
      priority: current.priority,
      assignedAdminUserId: current.assignedAdminUserId,
      oldStatus: current.status,
      newStatus: input.newStatus,
    };
  });
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
