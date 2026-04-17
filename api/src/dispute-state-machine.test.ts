import { describe, it, expect } from "vitest";
import {
  isValidDisputeTransition,
  DISPUTE_STATUS_TRANSITIONS,
  DISPUTE_STATUSES,
} from "./db/queries/dispute.js";

// ---------------------------------------------------------------------------
// Helper: generate all invalid transitions for the dispute state machine
// ---------------------------------------------------------------------------

function allInvalidTransitions(
  transitions: Record<string, string[]>,
  allValues: readonly string[],
): { from: string; to: string }[] {
  const invalid: { from: string; to: string }[] = [];
  for (const from of allValues) {
    const allowed = transitions[from] ?? [];
    for (const to of allValues) {
      if (from === to) continue;
      if (!allowed.includes(to)) {
        invalid.push({ from, to });
      }
    }
  }
  return invalid;
}

// ---------------------------------------------------------------------------
// dispute.status state machine (6.F)
// ---------------------------------------------------------------------------

describe("dispute.status state machine (T064)", () => {
  const validTransitions = [
    ["opened", "evidence_gathering"],
    ["opened", "accepted"],
    ["evidence_gathering", "ready_to_submit"],
    ["ready_to_submit", "submitted"],
    ["submitted", "won"],
    ["submitted", "lost"],
    ["won", "closed"],
    ["lost", "closed"],
    ["accepted", "closed"],
  ] as const;

  it.each(validTransitions)("allows %s → %s", (from, to) => {
    expect(isValidDisputeTransition(from, to)).toBe(true);
  });

  it("rejects every invalid dispute transition", () => {
    const invalid = allInvalidTransitions(DISPUTE_STATUS_TRANSITIONS, DISPUTE_STATUSES);
    expect(invalid.length).toBeGreaterThan(0);
    for (const { from, to } of invalid) {
      expect(isValidDisputeTransition(from, to), `Expected ${from} → ${to} to be invalid`).toBe(
        false,
      );
    }
  });

  it("rejects self-transitions", () => {
    for (const s of DISPUTE_STATUSES) {
      expect(isValidDisputeTransition(s, s)).toBe(false);
    }
  });

  it("terminal state (closed) has no outgoing transitions", () => {
    expect(DISPUTE_STATUS_TRANSITIONS["closed"]).toEqual([]);
  });

  it("opened can go to evidence_gathering or accepted (two paths)", () => {
    expect(DISPUTE_STATUS_TRANSITIONS["opened"]).toEqual(["evidence_gathering", "accepted"]);
  });

  it("submitted can resolve to won or lost", () => {
    expect(DISPUTE_STATUS_TRANSITIONS["submitted"]).toEqual(["won", "lost"]);
  });

  it("won, lost, accepted all lead to closed", () => {
    expect(DISPUTE_STATUS_TRANSITIONS["won"]).toEqual(["closed"]);
    expect(DISPUTE_STATUS_TRANSITIONS["lost"]).toEqual(["closed"]);
    expect(DISPUTE_STATUS_TRANSITIONS["accepted"]).toEqual(["closed"]);
  });

  it("rejects unknown from value", () => {
    expect(isValidDisputeTransition("nonexistent", "closed")).toBe(false);
  });

  it("rejects unknown to value", () => {
    expect(isValidDisputeTransition("opened", "nonexistent")).toBe(false);
  });
});
