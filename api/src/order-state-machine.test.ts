import { describe, it, expect } from "vitest";
import {
  isValidOrderTransition,
  STATUS_TRANSITIONS,
  PAYMENT_STATUS_TRANSITIONS,
  FULFILLMENT_STATUS_TRANSITIONS,
  SHIPPING_STATUS_TRANSITIONS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  FULFILLMENT_STATUSES,
  SHIPPING_STATUSES,
} from "./db/queries/order-state-machine.js";
import type { OrderStatusType } from "./db/queries/order-state-machine.js";

// ---------------------------------------------------------------------------
// Helper: generate all invalid transitions for a state machine
// ---------------------------------------------------------------------------

function allInvalidTransitions(
  statusType: OrderStatusType,
  transitions: Record<string, string[]>,
  allValues: readonly string[],
): { from: string; to: string }[] {
  const invalid: { from: string; to: string }[] = [];
  for (const from of allValues) {
    const allowed = transitions[from] ?? [];
    for (const to of allValues) {
      if (from === to) continue; // self-transition always invalid
      if (!allowed.includes(to)) {
        invalid.push({ from, to });
      }
    }
  }
  return invalid;
}

// ---------------------------------------------------------------------------
// order.status (6.A.1)
// ---------------------------------------------------------------------------

describe("order.status state machine", () => {
  const validTransitions = [
    ["draft", "pending_payment"],
    ["pending_payment", "confirmed"],
    ["pending_payment", "canceled"],
    ["confirmed", "completed"],
    ["confirmed", "canceled"],
    ["completed", "closed"],
  ] as const;

  it.each(validTransitions)("allows %s → %s", (from, to) => {
    expect(isValidOrderTransition("status", from, to)).toBe(true);
  });

  it("rejects every invalid status transition", () => {
    const invalid = allInvalidTransitions("status", STATUS_TRANSITIONS, ORDER_STATUSES);
    expect(invalid.length).toBeGreaterThan(0);
    for (const { from, to } of invalid) {
      expect(
        isValidOrderTransition("status", from, to),
        `Expected ${from} → ${to} to be invalid`,
      ).toBe(false);
    }
  });

  it("rejects self-transitions", () => {
    for (const s of ORDER_STATUSES) {
      expect(isValidOrderTransition("status", s, s)).toBe(false);
    }
  });

  it("terminal states (canceled, closed) have no outgoing transitions", () => {
    expect(STATUS_TRANSITIONS["canceled"]).toEqual([]);
    expect(STATUS_TRANSITIONS["closed"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// order.payment_status (6.A.2)
// ---------------------------------------------------------------------------

describe("order.payment_status state machine", () => {
  const validTransitions = [
    ["unpaid", "processing"],
    ["processing", "paid"],
    ["processing", "failed"],
    ["paid", "partially_refunded"],
    ["paid", "refunded"],
    ["paid", "disputed"],
    ["partially_refunded", "refunded"],
    ["disputed", "paid"],
    ["disputed", "refunded"],
  ] as const;

  it.each(validTransitions)("allows %s → %s", (from, to) => {
    expect(isValidOrderTransition("payment_status", from, to)).toBe(true);
  });

  it("rejects every invalid payment_status transition", () => {
    const invalid = allInvalidTransitions(
      "payment_status",
      PAYMENT_STATUS_TRANSITIONS,
      PAYMENT_STATUSES,
    );
    expect(invalid.length).toBeGreaterThan(0);
    for (const { from, to } of invalid) {
      expect(
        isValidOrderTransition("payment_status", from, to),
        `Expected ${from} → ${to} to be invalid`,
      ).toBe(false);
    }
  });

  it("terminal states (refunded, failed) have no outgoing transitions", () => {
    expect(PAYMENT_STATUS_TRANSITIONS["refunded"]).toEqual([]);
    expect(PAYMENT_STATUS_TRANSITIONS["failed"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// order.fulfillment_status (6.A.3)
// ---------------------------------------------------------------------------

describe("order.fulfillment_status state machine", () => {
  const validTransitions = [
    ["unfulfilled", "queued"],
    ["unfulfilled", "canceled"],
    ["queued", "picking"],
    ["queued", "partially_fulfilled"],
    ["queued", "canceled"],
    ["picking", "packing"],
    ["picking", "partially_fulfilled"],
    ["picking", "canceled"],
    ["packing", "ready_to_ship"],
    ["packing", "partially_fulfilled"],
    ["packing", "canceled"],
    ["ready_to_ship", "fulfilled"],
    ["ready_to_ship", "partially_fulfilled"],
    ["partially_fulfilled", "fulfilled"],
  ] as const;

  it.each(validTransitions)("allows %s → %s", (from, to) => {
    expect(isValidOrderTransition("fulfillment_status", from, to)).toBe(true);
  });

  it("rejects every invalid fulfillment_status transition", () => {
    const invalid = allInvalidTransitions(
      "fulfillment_status",
      FULFILLMENT_STATUS_TRANSITIONS,
      FULFILLMENT_STATUSES,
    );
    expect(invalid.length).toBeGreaterThan(0);
    for (const { from, to } of invalid) {
      expect(
        isValidOrderTransition("fulfillment_status", from, to),
        `Expected ${from} → ${to} to be invalid`,
      ).toBe(false);
    }
  });

  it("terminal states (fulfilled, canceled) have no outgoing transitions", () => {
    expect(FULFILLMENT_STATUS_TRANSITIONS["fulfilled"]).toEqual([]);
    expect(FULFILLMENT_STATUS_TRANSITIONS["canceled"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// order.shipping_status (6.A.4)
// ---------------------------------------------------------------------------

describe("order.shipping_status state machine", () => {
  const validTransitions = [
    ["not_shipped", "label_pending"],
    ["not_shipped", "canceled"],
    ["label_pending", "label_purchased"],
    ["label_pending", "canceled"],
    ["label_purchased", "shipped"],
    ["label_purchased", "canceled"],
    ["shipped", "in_transit"],
    ["in_transit", "out_for_delivery"],
    ["in_transit", "delivery_exception"],
    ["out_for_delivery", "delivered"],
    ["out_for_delivery", "delivery_exception"],
    ["delivered", "returned"],
    ["delivery_exception", "returned"],
  ] as const;

  it.each(validTransitions)("allows %s → %s", (from, to) => {
    expect(isValidOrderTransition("shipping_status", from, to)).toBe(true);
  });

  it("rejects every invalid shipping_status transition", () => {
    const invalid = allInvalidTransitions(
      "shipping_status",
      SHIPPING_STATUS_TRANSITIONS,
      SHIPPING_STATUSES,
    );
    expect(invalid.length).toBeGreaterThan(0);
    for (const { from, to } of invalid) {
      expect(
        isValidOrderTransition("shipping_status", from, to),
        `Expected ${from} → ${to} to be invalid`,
      ).toBe(false);
    }
  });

  it("terminal states (returned, canceled) have no outgoing transitions", () => {
    expect(SHIPPING_STATUS_TRANSITIONS["returned"]).toEqual([]);
    expect(SHIPPING_STATUS_TRANSITIONS["canceled"]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

describe("isValidOrderTransition edge cases", () => {
  it("rejects unknown status type values", () => {
    expect(isValidOrderTransition("bogus" as OrderStatusType, "draft", "pending_payment")).toBe(
      false,
    );
  });

  it("rejects unknown from value", () => {
    expect(isValidOrderTransition("status", "nonexistent", "confirmed")).toBe(false);
  });

  it("rejects unknown to value", () => {
    expect(isValidOrderTransition("status", "draft", "nonexistent")).toBe(false);
  });
});
