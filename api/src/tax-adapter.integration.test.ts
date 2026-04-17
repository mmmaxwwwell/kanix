import { describe, it, expect } from "vitest";
import {
  createTaxAdapter,
  type TaxLineItem,
  type ShippingAddress,
} from "./services/tax-adapter.js";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const sampleLineItems: TaxLineItem[] = [
  { amount: 2500, reference: "Test Widget", quantity: 1 },
  { amount: 1000, reference: "Test Gadget", quantity: 2 },
];

const txAddress: ShippingAddress = {
  line1: "1000 Main St",
  city: "Houston",
  state: "TX",
  postalCode: "77001",
  country: "US",
};

// ---------------------------------------------------------------------------
// Stub mode tests (STRIPE_TAX_ENABLED=false)
// ---------------------------------------------------------------------------

describe("tax adapter — stub mode (T048)", () => {
  const adapter = createTaxAdapter({
    stripeTaxEnabled: false,
    stripeSecretKey: "",
  });

  it("returns 0 tax for any line items", async () => {
    const result = await adapter.calculate(sampleLineItems, txAddress);
    expect(result.taxAmountMinor).toBe(0);
    expect(result.calculationId).toBeNull();
  });

  it("returns 0 tax for empty line items", async () => {
    const result = await adapter.calculate([], txAddress);
    expect(result.taxAmountMinor).toBe(0);
    expect(result.calculationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stripe Tax API tests (STRIPE_TAX_ENABLED=true, requires live test key)
// ---------------------------------------------------------------------------

const STRIPE_SECRET_KEY = process.env["STRIPE_SECRET_KEY"] ?? "";
const STRIPE_TAX_ENABLED = process.env["STRIPE_TAX_ENABLED"] === "true";

const canRunStripe = STRIPE_TAX_ENABLED && STRIPE_SECRET_KEY.startsWith("sk_test_");
const describeStripe = canRunStripe ? describe : describe.skip;

describeStripe("tax adapter — Stripe Tax API (T048)", () => {
  const adapter = createTaxAdapter({
    stripeTaxEnabled: true,
    stripeSecretKey: STRIPE_SECRET_KEY,
  });

  it("calculates tax for a TX address", async () => {
    const result = await adapter.calculate(sampleLineItems, txAddress);
    // Texas has sales tax — amount should be > 0
    expect(result.taxAmountMinor).toBeGreaterThan(0);
    expect(result.calculationId).toBeTruthy();
    expect(typeof result.calculationId).toBe("string");
  }, 15000); // Allow time for Stripe API call
});
